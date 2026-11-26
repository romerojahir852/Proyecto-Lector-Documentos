import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ServicioIngestaDocumental } from "./servicioIngesta.ts";
import type { DocumentoIngestaInput } from "./servicioIngesta.ts";

export interface OpcionesVigilanteCarpeta {
  servicio: ServicioIngestaDocumental;
  carpetaEntrada: string;
  carpetaProcesados?: string;
  carpetaErrores?: string;
  tenantId: string;
}

export interface ResultadoProcesamientoCarpeta {
  archivosDetectados: number;
  loteId?: string;
  archivosProcesados: string[];
  archivosError: string[];
}

export class VigilanteCarpetaEntrada {
  private readonly servicio: ServicioIngestaDocumental;
  private readonly carpetaEntrada: string;
  private readonly carpetaProcesados: string;
  private readonly carpetaErrores: string;
  private readonly tenantId: string;

  constructor(opciones: OpcionesVigilanteCarpeta) {
    this.servicio = opciones.servicio;
    this.tenantId = opciones.tenantId;
    this.carpetaEntrada = resolve(opciones.carpetaEntrada);
    this.carpetaProcesados = resolve(
      opciones.carpetaProcesados || join(this.carpetaEntrada, "..", "procesados")
    );
    this.carpetaErrores = resolve(
      opciones.carpetaErrores || join(this.carpetaEntrada, "..", "errores")
    );

    this.asegurarDirectorios();
  }

  private asegurarDirectorios(): void {
    if (!existsSync(this.carpetaEntrada)) mkdirSync(this.carpetaEntrada, { recursive: true });
    if (!existsSync(this.carpetaProcesados)) mkdirSync(this.carpetaProcesados, { recursive: true });
    if (!existsSync(this.carpetaErrores)) mkdirSync(this.carpetaErrores, { recursive: true });
  }

  async procesarArchivosPendientes(): Promise<ResultadoProcesamientoCarpeta> {
    this.asegurarDirectorios();

    const archivos = readdirSync(this.carpetaEntrada, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith("."))
      .map((d) => d.name);

    if (archivos.length === 0) {
      return {
        archivosDetectados: 0,
        archivosProcesados: [],
        archivosError: [],
      };
    }

    const docsInput: DocumentoIngestaInput[] = [];
    const leidosCorrectamente: string[] = [];

    for (const nombre of archivos) {
      const rutaCompleta = join(this.carpetaEntrada, nombre);
      try {
        const contenido = readFileSync(rutaCompleta);
        docsInput.push({
          nombreOriginal: nombre,
          contenido,
        });
        leidosCorrectamente.push(nombre);
      } catch (err) {
        // Mover a errores si no se puede leer
        try {
          renameSync(rutaCompleta, join(this.carpetaErrores, nombre));
        } catch {}
      }
    }

    if (docsInput.length === 0) {
      return {
        archivosDetectados: archivos.length,
        archivosProcesados: [],
        archivosError: archivos,
      };
    }

    try {
      const res = await this.servicio.procesarLoteDocumentos(this.tenantId, docsInput);

      // Mover los archivos a carpeta procesados
      for (const nombre of leidosCorrectamente) {
        const origen = join(this.carpetaEntrada, nombre);
        const destino = join(this.carpetaProcesados, `${Date.now()}_${nombre}`);
        if (existsSync(origen)) {
          renameSync(origen, destino);
        }
      }

      return {
        archivosDetectados: archivos.length,
        loteId: res.loteId,
        archivosProcesados: leidosCorrectamente,
        archivosError: [],
      };
    } catch (err) {
      // Si falla la transacción completa, mover a carpeta de errores
      for (const nombre of leidosCorrectamente) {
        const origen = join(this.carpetaEntrada, nombre);
        const destino = join(this.carpetaErrores, `${Date.now()}_${nombre}`);
        if (existsSync(origen)) {
          renameSync(origen, destino);
        }
      }

      return {
        archivosDetectados: archivos.length,
        archivosProcesados: [],
        archivosError: leidosCorrectamente,
      };
    }
  }
}
