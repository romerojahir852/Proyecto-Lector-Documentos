import { RegistroExtractores } from "../extractors/index.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";
import {
  generarClaveDuplicadoProbable,
  validarYClasificarRegistro,
} from "../validator/validarRegistro.ts";
import type {
  ContextoValidacion,
  EstadoFlujo,
  RegistroCandidato,
  ResultadoValidacion,
} from "../validator/validarRegistro.ts";

export type EstadoCola = "pendiente" | "procesando" | "listo" | "error";

export interface TrabajoCola {
  archivo: ArchivoEntradaTrabajo;
  estadoCola: EstadoCola;
  intentos: number;
  ultimoError: string | null;
}

export interface RegistroProcesado {
  tenantId: string;
  loteId: string;
  archivoId: string;
  candidato: RegistroCandidato;
  validacion: ResultadoValidacion;
}

export interface ExpedienteAgrupado {
  tenantId: string;
  identificacion: string;
  nombreTercero: string | null;
  periodo: string;
  cantidadRegistros: number;
  montoTotal: number;
  tienePendientesRevision: boolean;
  registros: RegistroProcesado[];
}

export interface OpcionesCola {
  maxIntentos?: number;
  umbralConfianzaMinimo?: number;
  montoMaximoAlerta?: number;
}

export class ProcesadorLotes {
  private readonly extractores: RegistroExtractores;
  private readonly maxIntentos: number;
  private readonly umbralConfianzaMinimo: number;
  private readonly montoMaximoAlerta?: number;

  private readonly hashesPorTenant = new Map<string, Set<string>>();
  private readonly clavesPorTenant = new Map<string, Set<string>>();

  constructor(extractores?: RegistroExtractores, opciones?: OpcionesCola) {
    this.extractores = extractores ?? new RegistroExtractores();
    const rawIntentos = opciones?.maxIntentos ?? 3;
    this.maxIntentos = Number.isFinite(rawIntentos)
      ? Math.max(1, Math.min(10, Math.floor(rawIntentos)))
      : 3;
    this.umbralConfianzaMinimo = opciones?.umbralConfianzaMinimo ?? 0.85;
    this.montoMaximoAlerta = opciones?.montoMaximoAlerta;
  }

  private obtenerContextoTenant(tenantId: string): ContextoValidacion {
    if (!tenantId || tenantId.trim().length === 0) {
      throw new Error("tenantId es obligatorio para procesar en cola.");
    }
    let hashes = this.hashesPorTenant.get(tenantId);
    if (!hashes) {
      hashes = new Set<string>();
      this.hashesPorTenant.set(tenantId, hashes);
    }
    let claves = this.clavesPorTenant.get(tenantId);
    if (!claves) {
      claves = new Set<string>();
      this.clavesPorTenant.set(tenantId, claves);
    }
    return {
      hashesExistentesEnTenant: hashes,
      clavesDuplicadoProbable: claves,
      umbralConfianzaMinimo: this.umbralConfianzaMinimo,
      montoMaximoAlerta: this.montoMaximoAlerta,
    };
  }

  async procesarLote(
    tenantId: string,
    archivos: ArchivoEntradaTrabajo[]
  ): Promise<{
    trabajos: TrabajoCola[];
    registros: RegistroProcesado[];
    expedientes: ExpedienteAgrupado[];
  }> {
    const ctx = this.obtenerContextoTenant(tenantId);
    const trabajos: TrabajoCola[] = archivos.map((archivo) => ({
      archivo,
      estadoCola: "pendiente",
      intentos: 0,
      ultimoError: null,
    }));

    const registros: RegistroProcesado[] = [];

    for (const trabajo of trabajos) {
      if (trabajo.archivo.tenantId !== tenantId) {
        trabajo.estadoCola = "error";
        trabajo.ultimoError = "AISLAMIENTO_TENANT_VIOLADO";
        continue;
      }

      while (trabajo.intentos < this.maxIntentos && trabajo.estadoCola !== "listo") {
        trabajo.intentos += 1;
        trabajo.estadoCola = "procesando";
        try {
          const extractor = this.extractores.resolver(
            trabajo.archivo.mimeType,
            trabajo.archivo.nombreOriginal
          );
          const extraccion = await extractor.extraer(trabajo.archivo);

          for (const item of extraccion.candidatos) {
            const candidato: RegistroCandidato = {
              tipoDocumento: item.tipoDocumento ?? null,
              fechaDocumento: item.fechaDocumento ?? null,
              monto: item.monto ?? null,
              identificacion: item.identificacion ?? null,
              nombreTercero: item.nombreTercero ?? null,
              referencia: item.referencia ?? null,
              confianza: item.confianza,
              hashSha256: trabajo.archivo.hashSha256,
            };

            const validacion = validarYClasificarRegistro(candidato, ctx);

            if (
              validacion.identificacionLimpia &&
              validacion.fechaValida &&
              validacion.montoNormalizado !== null
            ) {
              ctx.clavesDuplicadoProbable.add(
                generarClaveDuplicadoProbable(
                  validacion.identificacionLimpia,
                  validacion.fechaValida,
                  validacion.montoNormalizado,
                  candidato.referencia
                )
              );
            }

            registros.push({
              tenantId,
              loteId: trabajo.archivo.loteId,
              archivoId: trabajo.archivo.id,
              candidato,
              validacion,
            });
          }

          ctx.hashesExistentesEnTenant.add(trabajo.archivo.hashSha256);
          trabajo.estadoCola = "listo";
          trabajo.ultimoError = null;
        } catch (err) {
          trabajo.ultimoError = err instanceof Error ? err.message : String(err);
          if (trabajo.intentos >= this.maxIntentos) {
            trabajo.estadoCola = "error";
          }
        }
      }
    }

    const expedientes = agruparEnExpedientes(tenantId, registros);
    return { trabajos, registros, expedientes };
  }
}

export function agruparEnExpedientes(
  tenantId: string,
  registros: RegistroProcesado[]
): ExpedienteAgrupado[] {
  const mapa = new Map<string, ExpedienteAgrupado>();

  for (const reg of registros) {
    if (reg.tenantId !== tenantId) continue;

    const identificacion = reg.validacion.identificacionLimpia ?? "SIN_IDENTIFICACION";
    const periodo = reg.validacion.fechaValida
      ? reg.validacion.fechaValida.slice(0, 7)
      : "SIN_PERIODO";
    const clave = `${tenantId}|${identificacion}|${periodo}`;

    let exp = mapa.get(clave);
    if (!exp) {
      exp = {
        tenantId,
        identificacion,
        nombreTercero: reg.candidato.nombreTercero ?? null,
        periodo,
        cantidadRegistros: 0,
        montoTotal: 0,
        tienePendientesRevision: false,
        registros: [],
      };
      mapa.set(clave, exp);
    }

    exp.cantidadRegistros += 1;
    if (reg.validacion.montoNormalizado !== null) {
      exp.montoTotal =
        Math.round((exp.montoTotal + reg.validacion.montoNormalizado) * 100) / 100;
    }
    const estado: EstadoFlujo = reg.validacion.estadoFlujo;
    if (estado === "revision_rapida") {
      exp.tienePendientesRevision = true;
    }
    if (!exp.nombreTercero && reg.candidato.nombreTercero) {
      exp.nombreTercero = reg.candidato.nombreTercero;
    }
    exp.registros.push(reg);
  }

  return Array.from(mapa.values());
}
