import type {
  ArchivoEntradaTrabajo,
  CampoExtraidoCandidato,
  ProveedorExtraccionDocumental,
  ResultadoExtraccion,
} from "./types.ts";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface OpcionesClienteHttpOcr {
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchFn?: FetchLike;
}

function normalizarConfianza(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

function validarObjeto(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function mapearCandidato(item: unknown): CampoExtraidoCandidato {
  if (!validarObjeto(item)) {
    throw new Error("Elemento candidato inválido en respuesta JSON del proveedor OCR.");
  }
  return {
    tipoDocumento:
      typeof item.tipoDocumento === "string" ? item.tipoDocumento : "otro",
    fechaDocumento:
      typeof item.fechaDocumento === "string" ? item.fechaDocumento : null,
    monto:
      typeof item.monto === "number" || typeof item.monto === "string"
        ? item.monto
        : null,
    identificacion:
      typeof item.identificacion === "string" ? item.identificacion : null,
    nombreTercero:
      typeof item.nombreTercero === "string" ? item.nombreTercero : null,
    referencia:
      typeof item.referencia === "string" ? item.referencia : null,
    confianza: normalizarConfianza(item.confianza),
    datosCrudos: validarObjeto(item.datosCrudos) ? item.datosCrudos : item,
  };
}

export class ClienteHttpExtraccionDocumental implements ProveedorExtraccionDocumental {
  readonly nombre = "ClienteHttpExtraccionDocumental";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchLike;

  constructor(opciones: OpcionesClienteHttpOcr) {
    if (!opciones.url || opciones.url.trim().length === 0) {
      throw new Error("url es obligatoria para ClienteHttpExtraccionDocumental.");
    }
    this.url = opciones.url.trim();
    const rawTimeout = opciones.timeoutMs ?? 15000;
    this.timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 15000;
    this.headers = {
      "content-type": "application/json",
      ...opciones.headers,
    };
    this.fetchFn = opciones.fetchFn ?? globalThis.fetch;
  }

  async extraerDocumento(archivo: ArchivoEntradaTrabajo): Promise<ResultadoExtraccion> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Timeout OCR (${this.timeoutMs} ms) excedido`));
    }, this.timeoutMs);

    let respuesta: Response;
    try {
      const contenidoBase64 =
        archivo.contenido instanceof Uint8Array
          ? Buffer.from(archivo.contenido).toString("base64")
          : typeof archivo.contenido === "string"
            ? Buffer.from(archivo.contenido, "utf8").toString("base64")
            : undefined;

      respuesta = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.headers,
        signal: controller.signal,
        body: JSON.stringify({
          archivoId: archivo.id,
          tenantId: archivo.tenantId,
          loteId: archivo.loteId,
          nombreOriginal: archivo.nombreOriginal,
          mimeType: archivo.mimeType,
          tamanoBytes: archivo.tamanoBytes,
          rutaStorage: archivo.rutaStorage,
          hashSha256: archivo.hashSha256,
          contenidoBase64,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`Timeout al consultar proveedor OCR (${this.timeoutMs} ms): ${msg}`);
      }
      throw new Error(`Error de red al consultar proveedor OCR: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!respuesta.ok) {
      throw new Error(
        `Error HTTP ${respuesta.status} del proveedor OCR para ${archivo.nombreOriginal}`
      );
    }

    let payload: unknown;
    try {
      const texto = await respuesta.text();
      payload = JSON.parse(texto);
    } catch {
      throw new Error(`Respuesta JSON inválida del proveedor OCR para ${archivo.nombreOriginal}`);
    }

    if (!validarObjeto(payload) || !Array.isArray(payload.candidatos) || payload.candidatos.length === 0) {
      throw new Error(
        `Estructura JSON inesperada del proveedor OCR para ${archivo.nombreOriginal}`
      );
    }

    return {
      canal: "docling_ocr",
      candidatos: payload.candidatos.map(mapearCandidato),
    };
  }
}
