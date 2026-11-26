import { createHash, randomUUID } from "node:crypto";
import type { ClienteDbPg } from "./clientePg.ts";
import { RepositorioDocumentos } from "./repositorio.ts";
import type { ClienteDb } from "./repositorio.ts";
import { ClienteHttpExtraccionDocumental } from "../extractors/clienteHttpOcr.ts";
import {
  ExtractorDirecto,
  ExtractorDoclingOcr,
  RegistroExtractores,
} from "../extractors/index.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";
import { ProcesadorLotes } from "../queue/procesadorLotes.ts";
import type { ResumenLote } from "../queue/procesadorLotes.ts";

export interface DocumentoIngestaInput {
  nombreOriginal: string;
  mimeType?: string;
  contenido: Uint8Array | string;
  rutaStorage?: string;
}

export interface ResultadoIngestaLote {
  tenantId: string;
  loteId: string;
  resumen: ResumenLote;
  expedientesConsolidados: number;
}

export interface IngestorConfig {
  db: ClienteDb;
  ocrUrl?: string;
  maxIntentos?: number;
  umbralConfianzaMinimo?: number;
}

export function deducirMimeType(nombre: string): string {
  const ext = nombre.slice(nombre.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".xml":
      return "application/xml";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

export function calcularSha256(contenido: Uint8Array | string): string {
  return createHash("sha256").update(contenido).digest("hex");
}

export class ServicioIngestaDocumental {
  private readonly db: ClienteDb;
  private readonly repo: RepositorioDocumentos;
  private readonly procesador: ProcesadorLotes;

  constructor(config: IngestorConfig) {
    this.db = config.db;
    this.repo = new RepositorioDocumentos(this.db);

    const extractores = [new ExtractorDirecto()];
    if (config.ocrUrl && config.ocrUrl.trim().length > 0) {
      extractores.push(
        new ExtractorDoclingOcr(
          new ClienteHttpExtraccionDocumental({ url: config.ocrUrl.trim() })
        )
      );
    } else {
      extractores.push(new ExtractorDoclingOcr());
    }

    this.procesador = new ProcesadorLotes(new RegistroExtractores(extractores), {
      maxIntentos: config.maxIntentos ?? 3,
      umbralConfianzaMinimo: config.umbralConfianzaMinimo ?? 0.85,
    });
  }

  async procesarLoteDocumentos(
    tenantId: string,
    documentos: DocumentoIngestaInput[],
    opciones?: { loteId?: string; etiquetaPeriodo?: string }
  ): Promise<ResultadoIngestaLote> {
    if (!tenantId || tenantId.trim().length === 0) {
      throw new Error("tenantId es obligatorio para procesar e ingresar documentos.");
    }
    if (!documentos || documentos.length === 0) {
      throw new Error("Se requiere al menos un documento para procesar el lote.");
    }

    const tId = tenantId.trim();
    const loteId = opciones?.loteId ?? randomUUID();
    const etiquetaPeriodo = opciones?.etiquetaPeriodo ?? new Date().toISOString().slice(0, 7);

    // Preparar ArchivoEntradaTrabajo
    const archivos: ArchivoEntradaTrabajo[] = documentos.map((doc, idx) => {
      const nombre = (doc.nombreOriginal || `archivo_${idx + 1}`).trim();
      const mime = doc.mimeType || deducirMimeType(nombre);
      const tamanoBytes =
        doc.contenido instanceof Uint8Array
          ? doc.contenido.length
          : Buffer.byteLength(doc.contenido, "utf8");
      const hash = calcularSha256(doc.contenido);
      const archivoId = randomUUID();
      const rutaStorage = doc.rutaStorage || `${tId}/${loteId}/${nombre}`;

      return {
        id: archivoId,
        tenantId: tId,
        loteId,
        nombreOriginal: nombre,
        mimeType: mime,
        tamanoBytes,
        rutaStorage,
        hashSha256: hash,
        contenido: doc.contenido,
      };
    });

    // Fase 1: Registrar lote y archivos iniciales
    await this.repo.ejecutarEnTransaccion(tId, async (repoTx) => {
      await repoTx.crearLote({
        id: loteId,
        tenantId: tId,
        etiquetaPeriodo,
        estado: "procesando",
        totalArchivos: archivos.length,
        procesados: 0,
      });

      for (const arch of archivos) {
        await repoTx.registrarArchivoEntrada({
          id: arch.id,
          tenantId: tId,
          loteId,
          nombreOriginal: arch.nombreOriginal,
          mimeType: arch.mimeType,
          tamanoBytes: arch.tamanoBytes,
          rutaStorage: arch.rutaStorage,
          hashSha256: arch.hashSha256,
          estadoCola: "pendiente",
          intentos: 0,
        });
      }
    });

    // Fase 2: Procesar con el motor determinista
    const resultado = await this.procesador.procesarLote(tId, archivos);

    // Fase 3: Persistir resultados de extracción, expedientes y estado final
    let expedientesGuardados = 0;
    await this.repo.ejecutarEnTransaccion(tId, async (repoTx) => {
      for (const trabajo of resultado.trabajos) {
        await repoTx.actualizarEstadoArchivo({
          tenantId: tId,
          archivoId: trabajo.archivo.id,
          estadoCola: trabajo.estadoCola,
          intentos: trabajo.intentos,
          ultimoError: trabajo.ultimoError,
        });
      }

      const indicePorArchivo = new Map<string, number>();
      for (const reg of resultado.registros) {
        const idx = indicePorArchivo.get(reg.archivoId) ?? 0;
        indicePorArchivo.set(reg.archivoId, idx + 1);

        await repoTx.guardarRegistroExtraido({
          tenantId: reg.tenantId,
          loteId: reg.loteId,
          archivoId: reg.archivoId,
          indiceCandidato: idx,
          tipoDocumento: reg.candidato.tipoDocumento ?? null,
          fechaDocumento: reg.validacion.fechaValida,
          monto: reg.validacion.montoNormalizado,
          identificacion: reg.validacion.identificacionLimpia,
          nombreTercero: reg.candidato.nombreTercero ?? null,
          referencia: reg.candidato.referencia ?? null,
          confianza: reg.candidato.confianza,
          estadoFlujo: reg.validacion.estadoFlujo,
          motivosAlerta: reg.validacion.motivosAlerta,
          datosCrudos: {
            referenciaOriginal: reg.candidato.referencia ?? null,
            hashSha256: reg.candidato.hashSha256,
          },
        });
      }

      for (const exp of resultado.expedientes) {
        await repoTx.consolidarExpediente({
          tenantId: exp.tenantId,
          identificacion: exp.identificacion,
          nombreTercero: exp.nombreTercero,
          periodo: exp.periodo,
          cantidadRegistros: exp.cantidadRegistros,
          montoTotal: exp.montoTotal,
          tienePendientesRevision: exp.tienePendientesRevision,
        });
        expedientesGuardados++;
      }

      const estadoLote =
        resultado.resumen.estadoLote === "procesando"
          ? "procesando"
          : resultado.resumen.estadoLote;
      await repoTx.actualizarEstadoLote({
        tenantId: tId,
        loteId,
        estado: estadoLote,
        totalArchivos: resultado.resumen.totalArchivos,
        procesados:
          resultado.resumen.archivosListos + resultado.resumen.archivosConError,
      });
    });

    return {
      tenantId: tId,
      loteId,
      resumen: resultado.resumen,
      expedientesConsolidados: expedientesGuardados,
    };
  }
}
