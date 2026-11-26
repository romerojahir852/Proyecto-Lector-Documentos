import type {
  ArchivoEntradaTrabajo,
  CampoExtraidoCandidato,
  ExtractorDocumentos,
  ProveedorExtraccionDocumental,
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

function decodificarTexto(contenido: Uint8Array | string): string {
  if (typeof contenido === "string") return contenido;
  return new TextDecoder("utf-8", { fatal: false }).decode(contenido);
}

function parsearCsv(texto: string, nombreArchivo: string): CampoExtraidoCandidato[] {
  const lineas = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lineas.length < 2) {
    throw new Error(`CSV sin filas de datos en: ${nombreArchivo}`);
  }

  const separador =
    (lineas[0].match(/;/g)?.length ?? 0) > (lineas[0].match(/,/g)?.length ?? 0)
      ? ";"
      : ",";

  const headers = lineas[0].split(separador).map((h) => h.trim().toLowerCase());
  const idxCol = (nombres: string[]) => headers.findIndex((h) => nombres.includes(h));

  const iTipo = idxCol(["tipo", "tipo_documento", "doc"]);
  const iFecha = idxCol(["fecha", "fecha_documento", "fechaemision"]);
  const iMonto = idxCol(["monto", "total", "importe", "importetotal"]);
  const iId = idxCol(["identificacion", "ruc", "cedula", "identificador"]);
  const iTercero = idxCol(["tercero", "nombre", "razon_social", "razonsocial"]);
  const iRef = idxCol(["referencia", "numero", "comprobante", "autorizacion"]);

  const candidatos: CampoExtraidoCandidato[] = [];
  for (let i = 1; i < lineas.length; i++) {
    const cols = lineas[i].split(separador).map((c) => c.trim().replace(/^"|"$/g, ""));
    candidatos.push({
      tipoDocumento: iTipo >= 0 ? cols[iTipo] || "comprobante" : "comprobante",
      fechaDocumento: iFecha >= 0 ? cols[iFecha] || null : null,
      monto: iMonto >= 0 ? cols[iMonto] || null : null,
      identificacion: iId >= 0 ? cols[iId] || null : null,
      nombreTercero: iTercero >= 0 ? cols[iTercero] || null : null,
      referencia: iRef >= 0 ? cols[iRef] || null : null,
      confianza: 0.96,
      datosCrudos: { fila: i + 1, columnas: cols },
    });
  }
  return candidatos;
}

function extraerEtiquetaXml(xml: string, etiquetas: string[]): string | null {
  for (const tag of etiquetas) {
    const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
    const match = regex.exec(xml);
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return null;
}

function parsearXml(texto: string, nombreArchivo: string): CampoExtraidoCandidato[] {
  const limpio = texto.trim();
  if (!limpio.startsWith("<") || !limpio.endsWith(">")) {
    throw new Error(`XML malformado o incompleto en: ${nombreArchivo}`);
  }

  const identificacion = extraerEtiquetaXml(limpio, [
    "ruc",
    "identificacioncomprador",
    "identificacion",
    "cedula",
  ]);
  const nombreTercero = extraerEtiquetaXml(limpio, [
    "razonsocial",
    "razon_social",
    "nombre",
    "tercero",
  ]);
  const fechaDocumento = extraerEtiquetaXml(limpio, [
    "fechaemision",
    "fecha_documento",
    "fecha",
  ]);
  const monto = extraerEtiquetaXml(limpio, [
    "importetotal",
    "monto",
    "total",
    "valortotal",
  ]);
  const referencia = extraerEtiquetaXml(limpio, [
    "secuencial",
    "referencia",
    "numeroautorizacion",
    "claveacceso",
  ]);

  return [
    {
      tipoDocumento: "factura",
      fechaDocumento,
      monto,
      identificacion,
      nombreTercero,
      referencia,
      confianza: 0.98,
      datosCrudos: { origen: "ExtractorDirecto.xml", archivo: nombreArchivo },
    },
  ];
}

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
    const ext = extraerExtension(archivo.nombreOriginal);

    if (archivo.contenido !== undefined) {
      const texto = decodificarTexto(archivo.contenido).trim();

      if (texto.startsWith("{")) {
        const parsed: unknown = JSON.parse(texto);
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

      if (ext === ".csv" || archivo.mimeType.toLowerCase().includes("csv")) {
        return {
          canal: this.canal,
          candidatos: parsearCsv(texto, archivo.nombreOriginal),
        };
      }

      if (ext === ".xml" || archivo.mimeType.toLowerCase().includes("xml")) {
        return {
          canal: this.canal,
          candidatos: parsearXml(texto, archivo.nombreOriginal),
        };
      }
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

function acotarConfianza(confianza: number): number {
  if (typeof confianza !== "number" || !Number.isFinite(confianza)) return 0;
  return Math.max(0, Math.min(1, confianza));
}

export class ExtractorDoclingOcr implements ExtractorDocumentos {
  readonly nombre = "ExtractorDoclingOcr";
  readonly canal = "docling_ocr" as const;
  private readonly proveedor?: ProveedorExtraccionDocumental;

  constructor(proveedor?: ProveedorExtraccionDocumental) {
    this.proveedor = proveedor;
  }

  soporta(mimeType: string, nombreArchivo: string): boolean {
    const ext = extraerExtension(nombreArchivo);
    return (
      MIME_OCR.has(mimeType.toLowerCase()) ||
      [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tiff"].includes(ext)
    );
  }

  async extraer(archivo: ArchivoEntradaTrabajo): Promise<ResultadoExtraccion> {
    validarArchivoNoVacio(archivo);

    if (this.proveedor) {
      const resultado = await this.proveedor.extraerDocumento(archivo);
      return {
        canal: this.canal,
        candidatos: resultado.candidatos.map((c) => ({
          ...c,
          confianza: acotarConfianza(c.confianza),
        })),
      };
    }

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
