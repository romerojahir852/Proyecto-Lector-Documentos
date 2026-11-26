import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcesadorLotes } from "../queue/procesadorLotes.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";

function crearArchivoJson(
  overrides: Partial<ArchivoEntradaTrabajo> & { payload?: Record<string, unknown> }
): ArchivoEntradaTrabajo {
  const { payload, ...rest } = overrides;
  const contenido = payload ? JSON.stringify(payload) : undefined;
  return {
    id: "arch-1",
    tenantId: "tenant-a",
    loteId: "lote-1",
    nombreOriginal: "doc.xml",
    mimeType: "application/xml",
    tamanoBytes: contenido ? contenido.length : 100,
    rutaStorage: "tenant-a/lote-1/doc.xml",
    hashSha256: "sha-default",
    contenido,
    ...rest,
  };
}

describe("ProcesadorLotes", () => {
  it("aísla hashes y duplicados entre tenants distintos", async () => {
    const procesador = new ProcesadorLotes();
    const payload = {
      tipoDocumento: "factura",
      fechaDocumento: "2026-11-20",
      monto: "150.00",
      identificacion: "1790012345001",
      nombreTercero: "Proveedor Uno S.A.",
      referencia: "FAC-100",
      confianza: 0.98,
    };

    const resA = await procesador.procesarLote("tenant-a", [
      crearArchivoJson({ id: "a1", tenantId: "tenant-a", hashSha256: "hash-igual", payload }),
    ]);
    const resB = await procesador.procesarLote("tenant-b", [
      crearArchivoJson({ id: "b1", tenantId: "tenant-b", hashSha256: "hash-igual", payload }),
    ]);

    assert.equal(resA.registros[0].validacion.estadoFlujo, "listo");
    assert.equal(resB.registros[0].validacion.estadoFlujo, "listo");
  });

  it("rechaza archivos pertenecientes a otro tenant dentro del lote", async () => {
    const procesador = new ProcesadorLotes();
    const res = await procesador.procesarLote("tenant-a", [
      crearArchivoJson({ id: "x1", tenantId: "tenant-otro" }),
    ]);

    assert.equal(res.trabajos[0].estadoCola, "error");
    assert.equal(res.trabajos[0].ultimoError, "AISLAMIENTO_TENANT_VIOLADO");
    assert.equal(res.registros.length, 0);
  });

  it("limita los reintentos en archivos vacíos o no soportados", async () => {
    const procesador = new ProcesadorLotes(undefined, { maxIntentos: 2 });
    const res = await procesador.procesarLote("tenant-a", [
      crearArchivoJson({
        id: "vacio-1",
        tenantId: "tenant-a",
        nombreOriginal: "vacio.xml",
        tamanoBytes: 0,
      }),
    ]);

    assert.equal(res.trabajos[0].estadoCola, "error");
    assert.equal(res.trabajos[0].intentos, 2);
    assert.match(res.trabajos[0].ultimoError ?? "", /Archivo vacío/);
  });

  it("agrupa registros en expedientes por identificación y período", async () => {
    const procesador = new ProcesadorLotes();
    const res = await procesador.procesarLote("tenant-a", [
      crearArchivoJson({
        id: "f1",
        hashSha256: "h1",
        payload: {
          tipoDocumento: "factura",
          fechaDocumento: "2026-11-10",
          monto: "100.25",
          identificacion: "1790012345001",
          nombreTercero: "Comercial Alpha",
          referencia: "FAC-001",
          confianza: 0.95,
        },
      }),
      crearArchivoJson({
        id: "f2",
        hashSha256: "h2",
        payload: {
          tipoDocumento: "factura",
          fechaDocumento: "2026-11-18",
          monto: "200.50",
          identificacion: "1790012345001",
          nombreTercero: "Comercial Alpha",
          referencia: "FAC-002",
          confianza: 0.72,
        },
      }),
    ]);

    assert.equal(res.expedientes.length, 1);
    assert.equal(res.expedientes[0].cantidadRegistros, 2);
    assert.equal(res.expedientes[0].montoTotal, 300.75);
    assert.equal(res.expedientes[0].tienePendientesRevision, true);
    assert.equal(res.expedientes[0].periodo, "2026-11");
  });
});
