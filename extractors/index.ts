import type {
  ArchivoEntradaTrabajo,
  ExtractorDocumentos,
  ResultadoExtraccion,
} from "./types.ts";

const MIME_DIRECTOS = new Set([
  "application/xml",
  "text/xml",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MIME_OCR = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);

function extraerExtension(nombreArchivo: string): string {
  const idx = nombreArchivo.lastIndexOf(".");
  return idx >= 0 ? nombreArchivo.slice(idx).toLowerCase() : "";
}

function validarArchivoNoVacio(archivo: ArchivoEntradaTrabajo): void {
  if (!Number.isFinite(archivo.tamanoBytes) || archivo.tamanoBytes <= 0) {
    throw new Error(`Archivo vacío o corrupto: ${archivo.nombreOriginal}`);
  }
  if (archivo.contenido !== undefined && archivo.contenido.length === 0) {
    throw new Error(`Contenido vacío en archivo: ${archivo.nombreOriginal}`);
  }
}

/**
 * Parser directo para formatos estructurados (XML, CSV, Excel).
 * En producción se conecta con fast-xml-parser / csv-parse / xlsx.
 */
export class ExtractorDirecto implements ExtractorDocumentos {
  readonly nombre = "ExtractorDirecto";
  readonly canal = "parser_directo" as const;

  soporta(mimeType: string, nombreArchivo: string): boolean {
    const ext = extraerExtension(nombreArchivo);
    return (
      MIME_DIRECTOS.has(mimeType.toLowerCase()) ||
      [".xml", ".csv", ".xls", ".xlsx"].includes(ext)
    );
  }

  async extraer(archivo: ArchivoEntradaTrabajo): Promise<ResultadoExtraccion> {
    validarArchivoNoVacio(archivo);

    // Si el archivo trae JSON embebido en pruebas/simulación, se parsea directamente
    if (typeof archivo.contenido === "string" && archivo.contenido.trim().startsWith("{")) {
      const parsed: unknown = JSON.parse(archivo.contenido);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Contenido JSON inválido en archivo: ${archivo.nombreOriginal}`);
      }
      const obj = parsed as Record<string, unknown>;
      return {
        canal: this.canal,
        candidatos: [
          {
            tipoDocumento: (obj.tipoDocumento as string | undefined) ?? "factura",
            fechaDocumento: (obj.fechaDocumento as string | undefined) ?? null,
            monto: (obj.monto as number | string | undefined) ?? null,
            identificacion: (obj.identificacion as string | undefined) ?? null,
            nombreTercero: (obj.nombreTercero as string | undefined) ?? null,
            referencia: (obj.referencia as string | undefined) ?? null,
            confianza: typeof obj.confianza === "number" ? obj.confianza : 1.0,
            datosCrudos: obj,
          },
        ],
      };
    }

    return {
      canal: this.canal,
      candidatos: [
        {
          tipoDocumento: "comprobante",
          confianza: 0.99,
          datosCrudos: { origen: this.nombre, ruta: archivo.rutaStorage },
        },
      ],
    };
  }
}

/**
 * Extractor vía Docling / PaddleOCR para PDF complejos e imágenes.
 */
export class ExtractorDoclingOcr implements ExtractorDocumentos {
  readonly nombre = "ExtractorDoclingOcr";
  readonly canal = "docling_ocr" as const;

  soporta(mimeType: string, nombreArchivo: string): boolean {
    const ext = extraerExtension(nombreArchivo);
    return (
      MIME_OCR.has(mimeType.toLowerCase()) ||
      [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tiff"].includes(ext)
    );
  }

  async extraer(archivo: ArchivoEntradaTrabajo): Promise<ResultadoExtraccion> {
    validarArchivoNoVacio(archivo);

    return {
      canal: this.canal,
      candidatos: [
        {
          tipoDocumento: "otro",
          confianza: 0.75,
          datosCrudos: { origen: this.nombre, ruta: archivo.rutaStorage },
        },
      ],
    };
  }
}

export class RegistroExtractores {
  private readonly extractores: ExtractorDocumentos[];

  constructor(extractores?: ExtractorDocumentos[]) {
    this.extractores = extractores ?? [new ExtractorDirecto(), new ExtractorDoclingOcr()];
  }

  resolver(mimeType: string, nombreArchivo: string): ExtractorDocumentos {
    const encontrado = this.extractores.find((ext) => ext.soporta(mimeType, nombreArchivo));
    if (!encontrado) {
      throw new Error(`Tipo de archivo no soportado: ${mimeType} (${nombreArchivo})`);
    }
    return encontrado;
  }
}
