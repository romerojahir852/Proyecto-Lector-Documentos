import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { ServicioIngestaDocumental } from "./servicioIngesta.ts";
import type { DocumentoIngestaInput } from "./servicioIngesta.ts";

export interface ServidorIngestaOpciones {
  servicio: ServicioIngestaDocumental;
  puerto?: number;
  tenantIdDefault?: string;
}

function leerCuerpoJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const texto = Buffer.concat(chunks).toString("utf8");
        if (!texto.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(texto));
      } catch (err) {
        reject(new Error("Cuerpo JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

function responderJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
}

export function crearServidorIngestaHttp(opciones: ServidorIngestaOpciones): Server {
  const { servicio, tenantIdDefault } = opciones;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const metodo = req.method?.toUpperCase();

    // Health check
    if (metodo === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      responderJson(res, 200, {
        status: "ok",
        servicio: "ingesta-documental-motor",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Endpoint de ingesta de lote
    if (metodo === "POST" && (url.pathname === "/api/ingesta" || url.pathname === "/api/documentos")) {
      try {
        const body = await leerCuerpoJson(req);

        // Header o body para tenantId
        const tenantId =
          (req.headers["x-tenant-id"] as string | undefined)?.trim() ||
          (body.tenantId as string | undefined)?.trim() ||
          tenantIdDefault;

        if (!tenantId) {
          responderJson(res, 400, {
            error: "tenantId es obligatorio (en header 'x-tenant-id' o en body.tenantId).",
          });
          return;
        }

        // Puede venir como un archivo único o un array de archivos
        let docsRaw: unknown[] = [];
        if (Array.isArray(body.documentos)) {
          docsRaw = body.documentos;
        } else if (body.nombreOriginal && (body.contenido || body.contenidoBase64)) {
          docsRaw = [body];
        } else {
          responderJson(res, 400, {
            error:
              "Debe enviar un array 'documentos' o los campos de un archivo único ('nombreOriginal' y 'contenido'/'contenidoBase64').",
          });
          return;
        }

        const documentos: DocumentoIngestaInput[] = docsRaw.map((d: any, idx: number) => {
          let contenido: Uint8Array | string;
          if (d.contenidoBase64) {
            contenido = Buffer.from(String(d.contenidoBase64), "base64");
          } else if (typeof d.contenido === "string") {
            contenido = d.contenido;
          } else {
            throw new Error(`Documento #${idx + 1} no tiene 'contenido' ni 'contenidoBase64'.`);
          }

          return {
            nombreOriginal: String(d.nombreOriginal || `doc_${idx + 1}`),
            mimeType: d.mimeType ? String(d.mimeType) : undefined,
            contenido,
            rutaStorage: d.rutaStorage ? String(d.rutaStorage) : undefined,
          };
        });

        const resultado = await servicio.procesarLoteDocumentos(tenantId, documentos, {
          loteId: typeof body.loteId === "string" ? body.loteId : undefined,
          etiquetaPeriodo: typeof body.etiquetaPeriodo === "string" ? body.etiquetaPeriodo : undefined,
        });

        responderJson(res, 201, {
          mensaje: "Lote recibido y procesado con éxito.",
          ...resultado,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        responderJson(res, 400, { error: msg });
      }
      return;
    }

    // Ruta no encontrada
    responderJson(res, 404, { error: `Ruta no encontrada: ${metodo} ${url.pathname}` });
  });
}
