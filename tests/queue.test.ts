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
      identificacion: "1790012344001",
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
          identificacion: "1790012344001",
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
          identificacion: "1790012344001",
          nombreTercero: "Comercial Alpha",
          referencia: "FAC-002",
          confianza: 0.72,
        },
      }),
    ]);

    assert.equal(res.expedientes.length, 1);
    assert.equal(res.expedientes[0].cantidadRegistros, 2);
    assert.equal(res.expedientes[0].cantidadListos, 1);
    assert.equal(res.expedientes[0].cantidadRevisionRapida, 1);
    assert.equal(res.expedientes[0].montoTotal, 300.75);
    assert.equal(res.expedientes[0].tienePendientesRevision, true);
    assert.equal(res.expedientes[0].periodo, "2026-11");
    assert.equal(res.resumen.estadoLote, "finalizado");
    assert.equal(res.resumen.registrosListos, 1);
    assert.equal(res.resumen.registrosRevisionRapida, 1);
  });

  it("parsea CSV real multi-fila y XML real sin marcar el mismo archivo como duplicado", async () => {
    const procesador = new ProcesadorLotes();
    const csvContenido = [
      "tipo;fecha;monto;ruc;razon_social;referencia",
      "factura;2026-11-12;45,50;1790012344001;Proveedor A;FAC-10",
      "factura;2026-11-13;54.50;1790012344001;Proveedor A;FAC-11",
    ].join("\n");

    const xmlContenido = `<factura>
      <ruc>0991234578001</ruc>
      <razonSocial>Servicios XML S.A.</razonSocial>
      <fechaEmision>2026-11-14</fechaEmision>
      <importeTotal>200.00</importeTotal>
      <secuencial>001-002-000999</secuencial>
    </factura>`;

    const res = await procesador.procesarLote("tenant-a", [
      {
        id: "csv-1",
        tenantId: "tenant-a",
        loteId: "lote-csv",
        nombreOriginal: "ventas.csv",
        mimeType: "text/csv",
        tamanoBytes: csvContenido.length,
        rutaStorage: "tenant-a/lote-csv/ventas.csv",
        hashSha256: "hash-csv-1",
        contenido: csvContenido,
      },
      {
        id: "xml-1",
        tenantId: "tenant-a",
        loteId: "lote-csv",
        nombreOriginal: "factura.xml",
        mimeType: "application/xml",
        tamanoBytes: xmlContenido.length,
        rutaStorage: "tenant-a/lote-csv/factura.xml",
        hashSha256: "hash-xml-1",
        contenido: xmlContenido,
      },
    ]);

    assert.equal(res.registros.length, 3);
    assert.equal(res.resumen.estadoLote, "finalizado");
    assert.equal(res.resumen.registrosListos, 3);
    assert.equal(res.resumen.registrosRevisionRapida, 0);
  });
});
