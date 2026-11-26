import { createHash } from "node:crypto";
import { crearClientePg } from "../db/clientePg.ts";
import type { ClienteDbPg } from "../db/clientePg.ts";
import { RepositorioDocumentos } from "../db/repositorio.ts";
import type { ClienteDb, ResultadoQuery } from "../db/repositorio.ts";
import { ClienteHttpExtraccionDocumental } from "../extractors/clienteHttpOcr.ts";
import {
  ExtractorDirecto,
  ExtractorDoclingOcr,
  RegistroExtractores,
} from "../extractors/index.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";
import { ProcesadorLotes } from "../queue/procesadorLotes.ts";

// ─── ClienteDbMemoria (para correr sin DATABASE_URL) ─────────────────────────

class ClienteDbMemoria implements ClienteDbPg {
  lotes = new Map<string, Record<string, unknown>>();
  archivos = new Map<string, Record<string, unknown>>();
  registros = new Map<string, Record<string, unknown>>();
  expedientes = new Map<string, Record<string, unknown>>();

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<ResultadoQuery<T>> {
    if (sql.includes("INSERT INTO lotes_carga")) {
      const [id, tenantId, etiquetaPeriodo, estado, totalArchivos, procesados] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const fila = {
        id,
        tenant_id: tenantId,
        etiqueta_periodo: etiquetaPeriodo ?? null,
        estado,
        total_archivos: totalArchivos,
        procesados,
      };
      this.lotes.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("UPDATE lotes_carga")) {
      const [tenantId, id, estado, totalArchivos, procesados] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const existente = this.lotes.get(key);
      if (!existente) return { rows: [], rowCount: 0 };
      const actualizada = { ...existente, estado, total_archivos: totalArchivos, procesados };
      this.lotes.set(key, actualizada);
      return { rows: [actualizada as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO archivos_entrada")) {
      const [
        id,
        tenantId,
        loteId,
        nombreOriginal,
        mimeType,
        tamanoBytes,
        rutaStorage,
        hashSha256,
        estadoCola,
        intentos,
        ultimoError,
      ] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const fila = {
        id,
        tenant_id: tenantId,
        lote_id: loteId,
        nombre_original: nombreOriginal,
        mime_type: mimeType,
        tamano_bytes: tamanoBytes,
        ruta_storage: rutaStorage,
        hash_sha256: hashSha256,
        estado_cola: estadoCola,
        intentos,
        ultimo_error: ultimoError,
      };
      this.archivos.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("UPDATE archivos_entrada")) {
      const [tenantId, archivoId, estadoCola, intentos, ultimoError] = params;
      const key = `${String(tenantId)}|${String(archivoId)}`;
      const existente = this.archivos.get(key);
      if (!existente) return { rows: [], rowCount: 0 };
      const actualizada = {
        ...existente,
        estado_cola: estadoCola,
        intentos,
        ultimo_error: ultimoError,
      };
      this.archivos.set(key, actualizada);
      return { rows: [actualizada as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO registros_extraidos")) {
      const [
        tenantId,
        loteId,
        archivoId,
        indiceCandidato,
        tipoDocumento,
        fechaDocumento,
        monto,
        identificacion,
        nombreTercero,
        referencia,
        confianza,
        estadoFlujo,
        motivosAlerta,
        datosCrudos,
      ] = params;
      const key = `${String(tenantId)}|${String(archivoId)}|${String(indiceCandidato)}`;
      const fila = {
        tenant_id: tenantId,
        lote_id: loteId,
        archivo_id: archivoId,
        indice_candidato: indiceCandidato,
        tipo_documento: tipoDocumento,
        fecha_documento: fechaDocumento,
        monto,
        identificacion,
        nombre_tercero: nombreTercero,
        referencia,
        confianza,
        estado_flujo: estadoFlujo,
        motivos_alerta: motivosAlerta,
        datos_crudos: datosCrudos,
      };
      this.registros.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO expedientes")) {
      const [
        tenantId,
        identificacion,
        nombreTercero,
        periodo,
        cantidadRegistros,
        montoTotal,
        tienePendientesRevision,
      ] = params;
      const key = `${String(tenantId)}|${String(identificacion)}|${String(periodo)}`;
      const existente = this.expedientes.get(key);
      const fila = {
        tenant_id: tenantId,
        identificacion,
        nombre_tercero: nombreTercero ?? existente?.nombre_tercero ?? null,
        periodo,
        cantidad_registros: cantidadRegistros,
        monto_total: montoTotal,
        tiene_pendientes_revision: tienePendientesRevision,
      };
      this.expedientes.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    throw new Error(`Consulta no soportada en ClienteDbMemoria: ${sql}`);
  }

  async transaccion<R>(fn: (tx: ClienteDb) => Promise<R>): Promise<R> {
    const snap = {
      lotes: new Map(this.lotes),
      archivos: new Map(this.archivos),
      registros: new Map(this.registros),
      expedientes: new Map(this.expedientes),
    };
    try {
      return await fn(this);
    } catch (err) {
      this.lotes = snap.lotes;
      this.archivos = snap.archivos;
      this.registros = snap.registros;
      this.expedientes = snap.expedientes;
      throw err;
    }
  }

  async cerrar(): Promise<void> {
    // Sin conexiones externas que liberar en memoria
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(contenido: string | Uint8Array): string {
  return createHash("sha256").update(contenido).digest("hex");
}

/**
 * Verifica si el servicio OCR está disponible en la URL dada.
 * Si responde correctamente a /health, devuelve true.
 * Si no responde o falla, devuelve false y loguea un aviso.
 */
async function verificarOcrDisponible(baseUrl: string): Promise<boolean> {
  // Derivar la URL de /health a partir de la URL de /extraer
  const healthUrl = baseUrl.replace(/\/extraer\/?$/, "/health");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      console.log(`✓ Servicio OCR disponible en ${healthUrl} — motor: ${body.motor ?? "desconocido"}`);
      return true;
    }
    console.warn(`⚠ Servicio OCR respondió HTTP ${res.status} en ${healthUrl}. Usando fallback local.`);
    return false;
  } catch {
    clearTimeout(timer);
    console.warn(`⚠ Servicio OCR no disponible en ${healthUrl} (¿está ejecutándose?). Usando fallback local sin OCR.`);
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const usandoPgReal = databaseUrl.length > 0;
  const db: ClienteDbPg = usandoPgReal
    ? crearClientePg(databaseUrl)
    : new ClienteDbMemoria();

  const tenantId =
    (process.env.FLOW_TENANT_ID ?? "").trim() ||
    "11111111-1111-4111-8111-111111111111";
  const loteId = "22222222-2222-4222-8222-222222222221";

  // ── Configurar extractor OCR con verificación previa ───────────────────
  const ocrUrl = (process.env.OCR_SERVICE_URL ?? "").trim();
  let extractorOcr: ExtractorDoclingOcr;
  if (ocrUrl) {
    const ocrActivo = await verificarOcrDisponible(ocrUrl);
    extractorOcr = ocrActivo
      ? new ExtractorDoclingOcr(new ClienteHttpExtraccionDocumental({ url: ocrUrl }))
      : new ExtractorDoclingOcr(); // fallback: sin proveedor HTTP
  } else {
    extractorOcr = new ExtractorDoclingOcr();
  }

  const procesador = new ProcesadorLotes(
    new RegistroExtractores([new ExtractorDirecto(), extractorOcr]),
    { maxIntentos: 3, umbralConfianzaMinimo: 0.85 }
  );

  // ── Datos de ejemplo ───────────────────────────────────────────────────
  const xmlFactura = `<factura>
    <ruc>1790012344001</ruc>
    <razonSocial>Distribuidora Andes S.A.</razonSocial>
    <fechaEmision>2026-11-20</fechaEmision>
    <importeTotal>450.75</importeTotal>
    <secuencial>001-001-000801</secuencial>
  </factura>`;

  const csvComprobantes = [
    "tipo;fecha;monto;ruc;razon_social;referencia",
    "comprobante;2026-11-21;149,25;1790012344001;Distribuidora Andes S.A.;TRF-7710",
    "factura;2026-11-22;320.00;0991234578001;Servicios Pacífico S.A.;FAC-502",
  ].join("\n");

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const archivos: ArchivoEntradaTrabajo[] = [
    {
      id: "33333333-3333-4333-8333-333333333301",
      tenantId,
      loteId,
      nombreOriginal: "factura_andes.xml",
      mimeType: "application/xml",
      tamanoBytes: Buffer.byteLength(xmlFactura, "utf8"),
      rutaStorage: `${tenantId}/${loteId}/factura_andes.xml`,
      hashSha256: sha256(xmlFactura),
      contenido: xmlFactura,
    },
    {
      id: "33333333-3333-4333-8333-333333333302",
      tenantId,
      loteId,
      nombreOriginal: "lote_comprobantes.csv",
      mimeType: "text/csv",
      tamanoBytes: Buffer.byteLength(csvComprobantes, "utf8"),
      rutaStorage: `${tenantId}/${loteId}/lote_comprobantes.csv`,
      hashSha256: sha256(csvComprobantes),
      contenido: csvComprobantes,
    },
    {
      id: "33333333-3333-4333-8333-333333333303",
      tenantId,
      loteId,
      nombreOriginal: "recibo_escaneado.pdf",
      mimeType: "application/pdf",
      tamanoBytes: pdfBytes.length,
      rutaStorage: `${tenantId}/${loteId}/recibo_escaneado.pdf`,
      hashSha256: sha256(pdfBytes),
      contenido: pdfBytes,
    },
  ];

  const repo = new RepositorioDocumentos(db);

  try {
    console.log(
      `\nModo de persistencia: ${usandoPgReal ? "PostgreSQL (DATABASE_URL)" : "ClienteDbMemoria (sin DATABASE_URL)"}`
    );
    console.log(`Tenant: ${tenantId}`);
    console.log(`Lote:   ${loteId}\n`);

    // ── Fase 1: Registrar lote y archivos ────────────────────────────────
    await repo.ejecutarEnTransaccion(tenantId, async (repoTx) => {
      await repoTx.crearLote({
        id: loteId,
        tenantId,
        etiquetaPeriodo: "2026-11",
        estado: "procesando",
        totalArchivos: archivos.length,
        procesados: 0,
      });

      for (const archivo of archivos) {
        await repoTx.registrarArchivoEntrada({
          id: archivo.id,
          tenantId,
          loteId,
          nombreOriginal: archivo.nombreOriginal,
          mimeType: archivo.mimeType,
          tamanoBytes: archivo.tamanoBytes,
          rutaStorage: archivo.rutaStorage,
          hashSha256: archivo.hashSha256,
          estadoCola: "pendiente",
          intentos: 0,
        });
      }
    });

    // ── Fase 2: Procesar lote (extracción + validación) ──────────────────
    const resultado = await procesador.procesarLote(tenantId, archivos);

    // ── Fase 3: Reporte detallado por archivo ────────────────────────────
    console.log("=== DETALLE POR ARCHIVO ===");
    for (const t of resultado.trabajos) {
      const icono = t.estadoCola === "listo" ? "✓" : t.estadoCola === "error" ? "✗" : "…";
      console.log(
        `  ${icono} ${t.archivo.nombreOriginal} [${t.archivo.mimeType}] → ${t.estadoCola} (${t.intentos} intento(s))`
      );
      if (t.estadoCola === "error" && t.ultimoError) {
        console.log(`    └─ Error: ${t.ultimoError}`);
      }
    }

    // ── Fase 4: Reporte detallado por registro ───────────────────────────
    console.log("\n=== DETALLE POR REGISTRO ===");
    for (const reg of resultado.registros) {
      const archivo = archivos.find((a) => a.id === reg.archivoId);
      const nombreArch = archivo?.nombreOriginal ?? reg.archivoId;
      const icono = reg.validacion.estadoFlujo === "listo" ? "✓" : "⚠";
      console.log(
        `  ${icono} [${reg.validacion.estadoFlujo}] ${reg.candidato.tipoDocumento ?? "?"} | ${reg.validacion.identificacionLimpia ?? "sin-id"} | $${reg.validacion.montoNormalizado ?? 0} | ${reg.validacion.fechaValida ?? "sin-fecha"} | ref:${reg.candidato.referencia ?? "—"} (de: ${nombreArch})`
      );
      if (reg.validacion.motivosAlerta.length > 0) {
        console.log(`    └─ Alertas: ${reg.validacion.motivosAlerta.join(", ")}`);
      }
    }

    // ── Fase 5: Persistir resultados ─────────────────────────────────────
    const expedientesPersistidos: Record<string, unknown>[] = [];

    await repo.ejecutarEnTransaccion(tenantId, async (repoTx) => {
      for (const trabajo of resultado.trabajos) {
        await repoTx.actualizarEstadoArchivo({
          tenantId,
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
        const filaExp = await repoTx.consolidarExpediente({
          tenantId: exp.tenantId,
          identificacion: exp.identificacion,
          nombreTercero: exp.nombreTercero,
          periodo: exp.periodo,
          cantidadRegistros: exp.cantidadRegistros,
          montoTotal: exp.montoTotal,
          tienePendientesRevision: exp.tienePendientesRevision,
        });
        expedientesPersistidos.push(filaExp);
      }

      const estadoLote =
        resultado.resumen.estadoLote === "procesando"
          ? "procesando"
          : resultado.resumen.estadoLote;
      await repoTx.actualizarEstadoLote({
        tenantId,
        loteId,
        estado: estadoLote,
        totalArchivos: resultado.resumen.totalArchivos,
        procesados:
          resultado.resumen.archivosListos + resultado.resumen.archivosConError,
      });
    });

    // ── Fase 6: Resumen final ────────────────────────────────────────────
    console.log("\n=== RESUMEN DEL LOTE ===");
    console.log(JSON.stringify(resultado.resumen, null, 2));

    console.log("\n=== EXPEDIENTES PERSISTIDOS ===");
    for (const exp of expedientesPersistidos) {
      const e = exp as Record<string, unknown>;
      console.log(
        `  📁 ${e.identificacion} | periodo: ${e.periodo} | registros: ${e.cantidad_registros} | monto: $${e.monto_total} | pendientes: ${e.tiene_pendientes_revision ? "sí" : "no"}`
      );
    }

    // ── Veredicto ────────────────────────────────────────────────────────
    const { estadoLote, archivosConError, totalArchivos, archivosListos } = resultado.resumen;
    if (estadoLote === "finalizado") {
      console.log(`\n✅ Lote finalizado correctamente: ${archivosListos}/${totalArchivos} archivos procesados.`);
    } else if (estadoLote === "con_errores") {
      console.log(`\n⚠ Lote con errores: ${archivosListos} OK, ${archivosConError} con error de ${totalArchivos} archivos.`);
    } else {
      console.log(`\n… Lote aún procesando.`);
    }
  } finally {
    await db.cerrar();
  }
}

main().catch((err) => {
  console.error("Error ejecutando el flujo real:", err);
  process.exitCode = 1;
});
