import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClienteHttpExtraccionDocumental } from "../extractors/clienteHttpOcr.ts";
import type { FetchLike } from "../extractors/clienteHttpOcr.ts";
import {
  ExtractorDirecto,
  ExtractorDoclingOcr,
  RegistroExtractores,
} from "../extractors/index.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";
import { ProcesadorLotes } from "../queue/procesadorLotes.ts";

function crearArchivoPdf(overrides?: Partial<ArchivoEntradaTrabajo>): ArchivoEntradaTrabajo {
  return {
    id: "pdf-1",
    tenantId: "tenant-ocr",
    loteId: "lote-ocr",
    nombreOriginal: "factura.pdf",
    mimeType: "application/pdf",
    tamanoBytes: 1024,
    rutaStorage: "tenant-ocr/lote-ocr/factura.pdf",
    hashSha256: "hash-pdf-1",
    contenido: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    ...overrides,
  };
}

describe("ClienteHttpExtraccionDocumental y ExtractorDoclingOcr", () => {
  it("mapea una extracción HTTP exitosa a CampoExtraidoCandidato sin red real", async () => {
    let urlInvocada = "";
    const fetchMock: FetchLike = async (input) => {
      urlInvocada = String(input);
      return new Response(
        JSON.stringify({
          candidatos: [
            {
              tipoDocumento: "factura",
              fechaDocumento: "2026-11-20",
              monto: "325.50",
              identificacion: "1790012344001",
              nombreTercero: "Importadora Andina S.A.",
              referencia: "001-001-000777",
              confianza: 0.94,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const cliente = new ClienteHttpExtraccionDocumental({
      url: "https://ocr.interno.test/extraer",
      timeoutMs: 5000,
      fetchFn: fetchMock,
    });
    const extractor = new ExtractorDoclingOcr(cliente);
    const resultado = await extractor.extraer(crearArchivoPdf());

    assert.equal(urlInvocada, "https://ocr.interno.test/extraer");
    assert.equal(resultado.canal, "docling_ocr");
    assert.equal(resultado.candidatos.length, 1);
    assert.equal(resultado.candidatos[0].identificacion, "1790012344001");
    assert.equal(resultado.candidatos[0].monto, "325.50");
    assert.equal(resultado.candidatos[0].confianza, 0.94);
  });

  it("aborta por timeout y captura errores HTTP o JSON inválido sin romper la cola", async () => {
    const fetchTimeout: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Operación abortada");
          err.name = "AbortError";
          reject(err);
        });
      });

    const clienteTimeout = new ClienteHttpExtraccionDocumental({
      url: "https://ocr.interno.test/lento",
      timeoutMs: 15,
      fetchFn: fetchTimeout,
    });

    const procesadorTimeout = new ProcesadorLotes(
      new RegistroExtractores([new ExtractorDirecto(), new ExtractorDoclingOcr(clienteTimeout)]),
      { maxIntentos: 1 }
    );
    const resTimeout = await procesadorTimeout.procesarLote("tenant-ocr", [crearArchivoPdf()]);
    assert.equal(resTimeout.trabajos[0].estadoCola, "error");
    assert.match(resTimeout.trabajos[0].ultimoError ?? "", /Timeout al consultar proveedor OCR/);
    assert.equal(resTimeout.resumen.estadoLote, "con_errores");

    const fetchHttp500: FetchLike = async () => new Response("Internal Error", { status: 500 });
    const procesadorHttp = new ProcesadorLotes(
      new RegistroExtractores([
        new ExtractorDirecto(),
        new ExtractorDoclingOcr(
          new ClienteHttpExtraccionDocumental({
            url: "https://ocr.interno.test/500",
            fetchFn: fetchHttp500,
          })
        ),
      ]),
      { maxIntentos: 2 }
    );
    const resHttp = await procesadorHttp.procesarLote("tenant-ocr", [crearArchivoPdf()]);
    assert.equal(resHttp.trabajos[0].estadoCola, "error");
    assert.equal(resHttp.trabajos[0].intentos, 2);
    assert.match(resHttp.trabajos[0].ultimoError ?? "", /Error HTTP 500/);

    const fetchJsonInvalido: FetchLike = async () =>
      new Response("{no-es-json", { status: 200 });
    const procesadorJson = new ProcesadorLotes(
      new RegistroExtractores([
        new ExtractorDirecto(),
        new ExtractorDoclingOcr(
          new ClienteHttpExtraccionDocumental({
            url: "https://ocr.interno.test/bad-json",
            fetchFn: fetchJsonInvalido,
          })
        ),
      ]),
      { maxIntentos: 1 }
    );
    const resJson = await procesadorJson.procesarLote("tenant-ocr", [crearArchivoPdf()]);
    assert.equal(resJson.trabajos[0].estadoCola, "error");
    assert.match(resJson.trabajos[0].ultimoError ?? "", /Respuesta JSON inválida/);
  });

  it("acota confianza fuera de [0, 1] y envía casos dudosos a revision_rapida", async () => {
    const fetchMock: FetchLike = async () =>
      new Response(
        JSON.stringify({
          candidatos: [
            {
              tipoDocumento: "factura",
              fechaDocumento: "2026-11-20",
              monto: 120.0,
              identificacion: "1790012344001",
              referencia: "FAC-OK-SUP",
              confianza: 1.8, // debe acotarse a 1
            },
            {
              tipoDocumento: "factura",
              fechaDocumento: "2026-11-20",
              monto: 80.0,
              identificacion: "1790012345001", // dígito verificador inválido (5 en lugar de 4)
              referencia: "FAC-DUDOSA",
              confianza: -0.4, // debe acotarse a 0
            },
          ],
        }),
        { status: 200 }
      );

    const cliente = new ClienteHttpExtraccionDocumental({
      url: "https://ocr.interno.test/extraer",
      fetchFn: fetchMock,
    });
    const procesador = new ProcesadorLotes(
      new RegistroExtractores([new ExtractorDirecto(), new ExtractorDoclingOcr(cliente)])
    );

    const res = await procesador.procesarLote("tenant-ocr", [crearArchivoPdf()]);

    assert.equal(res.registros.length, 2);
    assert.equal(res.registros[0].candidato.confianza, 1);
    assert.equal(res.registros[0].validacion.estadoFlujo, "listo");

    assert.equal(res.registros[1].candidato.confianza, 0);
    assert.equal(res.registros[1].validacion.estadoFlujo, "revision_rapida");
    assert.ok(res.registros[1].validacion.motivosAlerta.includes("BAJA_CONFIANZA_EXTRACCION"));
    assert.ok(
      res.registros[1].validacion.motivosAlerta.includes(
        "IDENTIFICACION_DIGITO_VERIFICADOR_INVALIDO"
      )
    );
  });

  it("rechaza archivos vacíos antes de invocar el proveedor HTTP OCR", async () => {
    let llamado = false;
    const fetchMock: FetchLike = async () => {
      llamado = true;
      return new Response("{}", { status: 200 });
    };

    const extractor = new ExtractorDoclingOcr(
      new ClienteHttpExtraccionDocumental({
        url: "https://ocr.interno.test/extraer",
        fetchFn: fetchMock,
      })
    );

    await assert.rejects(
      () => extractor.extraer(crearArchivoPdf({ tamanoBytes: 0 })),
      /Archivo vacío o corrupto/
    );
    assert.equal(llamado, false);
  });
});
