import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ServicioIngestaDocumental } from "../db/servicioIngesta.ts";
import { crearServidorIngestaHttp } from "../db/servidorHttpIngesta.ts";
import { VigilanteCarpetaEntrada } from "../db/vigilanteCarpeta.ts";
import type { ClienteDb, ResultadoQuery } from "../db/repositorio.ts";

class MockDb implements ClienteDb {
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
      const fila = { id, tenant_id: tenantId, etiqueta_periodo: etiquetaPeriodo, estado, total_archivos: totalArchivos, procesados };
      this.lotes.set(`${tenantId}|${id}`, fila);
      return { rows: [fila as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE lotes_carga")) {
      const [tenantId, id, estado, totalArchivos, procesados] = params;
      const key = `${tenantId}|${id}`;
      const actual = { ...this.lotes.get(key), estado, total_archivos: totalArchivos, procesados };
      this.lotes.set(key, actual);
      return { rows: [actual as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO archivos_entrada")) {
      const [id, tenantId, loteId, nombreOriginal, mimeType, tamanoBytes, rutaStorage, hashSha256, estadoCola, intentos, ultimoError] = params;
      const fila = { id, tenant_id: tenantId, lote_id: loteId, nombre_original: nombreOriginal, mime_type: mimeType, tamano_bytes: tamanoBytes, ruta_storage: rutaStorage, hash_sha256: hashSha256, estado_cola: estadoCola, intentos, ultimo_error: ultimoError };
      this.archivos.set(`${tenantId}|${id}`, fila);
      return { rows: [fila as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE archivos_entrada")) {
      const [tenantId, archivoId, estadoCola, intentos, ultimoError] = params;
      const key = `${tenantId}|${archivoId}`;
      const actual = { ...this.archivos.get(key), estado_cola: estadoCola, intentos, ultimo_error: ultimoError };
      this.archivos.set(key, actual);
      return { rows: [actual as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO registros_extraidos")) {
      const [tenantId, loteId, archivoId, indiceCandidato, tipoDocumento, fechaDocumento, monto, identificacion, nombreTercero, referencia, confianza, estadoFlujo, motivosAlerta, datosCrudos] = params;
      const fila = { tenant_id: tenantId, lote_id: loteId, archivo_id: archivoId, indice_candidato: indiceCandidato, tipo_documento: tipoDocumento, fecha_documento: fechaDocumento, monto, identificacion, nombre_tercero: nombreTercero, referencia, confianza, estado_flujo: estadoFlujo, motivos_alerta: motivosAlerta, datos_crudos: datosCrudos };
      this.registros.set(`${tenantId}|${archivoId}|${indiceCandidato}`, fila);
      return { rows: [fila as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO expedientes")) {
      const [tenantId, identificacion, nombreTercero, periodo, cantidadRegistros, montoTotal, tienePendientesRevision] = params;
      const key = `${tenantId}|${identificacion}|${periodo}`;
      const fila = { tenant_id: tenantId, identificacion, nombre_tercero: nombreTercero, periodo, cantidad_registros: cantidadRegistros, monto_total: montoTotal, tiene_pendientes_revision: tienePendientesRevision };
      this.expedientes.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaccion<R>(fn: (tx: ClienteDb) => Promise<R>): Promise<R> {
    return fn(this);
  }
}

describe("ServicioIngestaDocumental", () => {
  it("exige tenantId obligatorio y rechaza lotes sin documentos", async () => {
    const db = new MockDb();
    const servicio = new ServicioIngestaDocumental({ db });

    await assert.rejects(
      () => servicio.procesarLoteDocumentos("", [{ nombreOriginal: "doc.xml", contenido: "<xml/>" }]),
      /tenantId es obligatorio/
    );

    await assert.rejects(
      () => servicio.procesarLoteDocumentos("tenant-1", []),
      /Se requiere al menos un documento/
    );
  });

  it("procesa lote de documentos y consolida expedientes en persistencia", async () => {
    const db = new MockDb();
    const servicio = new ServicioIngestaDocumental({ db });

    const xml = `<factura>
      <ruc>1790012344001</ruc>
      <razonSocial>Proveedor Uno</razonSocial>
      <fechaEmision>2026-11-20</fechaEmision>
      <importeTotal>150.00</importeTotal>
      <secuencial>001-001-000100</secuencial>
    </factura>`;

    const csv = "tipo;fecha;monto;ruc;razon_social;referencia\ncomprobante;2026-11-21;50.00;1790012344001;Proveedor Uno;TRF-1";

    const res = await servicio.procesarLoteDocumentos("tenant-demo", [
      { nombreOriginal: "factura.xml", contenido: xml },
      { nombreOriginal: "comprobante.csv", contenido: csv },
    ]);

    assert.equal(res.resumen.totalArchivos, 2);
    assert.equal(res.resumen.archivosListos, 2);
    assert.equal(res.resumen.estadoLote, "finalizado");
    assert.equal(res.expedientesConsolidados, 1);
    assert.equal(db.lotes.size, 1);
    assert.equal(db.archivos.size, 2);
    assert.equal(db.registros.size, 2);
    assert.equal(db.expedientes.size, 1);

    const exp = Array.from(db.expedientes.values())[0];
    assert.equal(exp.identificacion, "1790012344001");
    assert.equal(exp.monto_total, 200);
    assert.equal(exp.cantidad_registros, 2);
  });
});

describe("crearServidorIngestaHttp", () => {
  it("responde a /health y procesa POST /api/ingesta con aislamiento de tenant", async () => {
    const db = new MockDb();
    const servicio = new ServicioIngestaDocumental({ db });
    const servidor = crearServidorIngestaHttp({ servicio });

    await new Promise<void>((resolve) => servidor.listen(0, resolve));
    const address = servidor.address();
    const puerto = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${puerto}`;

    try {
      // 1. Health check
      const resHealth = await fetch(`${base}/health`);
      assert.equal(resHealth.status, 200);
      const jsonHealth = (await resHealth.json()) as any;
      assert.equal(jsonHealth.status, "ok");

      // 2. Rechaza si no hay tenantId
      const resSinTenant = await fetch(`${base}/api/ingesta`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentos: [{ nombreOriginal: "doc.xml", contenido: "<xml/>" }],
        }),
      });
      assert.equal(resSinTenant.status, 400);

      // 3. Ingesta exitosa con header x-tenant-id
      const xml = `<factura>
        <ruc>0991234578001</ruc>
        <razonSocial>Servicios Pac</razonSocial>
        <fechaEmision>2026-11-22</fechaEmision>
        <importeTotal>320.00</importeTotal>
        <secuencial>001-002-000500</secuencial>
      </factura>`;

      const resOk = await fetch(`${base}/api/ingesta`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "tenant-api-test",
        },
        body: JSON.stringify({
          documentos: [{ nombreOriginal: "factura_pac.xml", contenido: xml }],
        }),
      });

      assert.equal(resOk.status, 201);
      const jsonOk = (await resOk.json()) as any;
      assert.equal(jsonOk.tenantId, "tenant-api-test");
      assert.equal(jsonOk.resumen.archivosListos, 1);
      assert.equal(jsonOk.resumen.registrosListos, 1);
    } finally {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
    }
  });
});

describe("VigilanteCarpetaEntrada", () => {
  it("detecta archivos en inbox, procesa el lote y los mueve a procesados", async () => {
    const db = new MockDb();
    const servicio = new ServicioIngestaDocumental({ db });

    const dirTest = resolve("./test_inbox_tmp");
    const dirEntrada = join(dirTest, "entrada");
    const dirProcesados = join(dirTest, "procesados");

    try {
      if (existsSync(dirTest)) rmSync(dirTest, { recursive: true, force: true });
      mkdirSync(dirEntrada, { recursive: true });

      const xml = `<factura>
        <ruc>1790012344001</ruc>
        <razonSocial>Andes Corp</razonSocial>
        <fechaEmision>2026-11-20</fechaEmision>
        <importeTotal>100.00</importeTotal>
        <secuencial>001-001-000001</secuencial>
      </factura>`;

      writeFileSync(join(dirEntrada, "factura1.xml"), xml, "utf8");

      const vigilante = new VigilanteCarpetaEntrada({
        servicio,
        tenantId: "tenant-watcher",
        carpetaEntrada: dirEntrada,
        carpetaProcesados: dirProcesados,
      });

      const res = await vigilante.procesarArchivosPendientes();
      assert.equal(res.archivosDetectados, 1);
      assert.equal(res.archivosProcesados.length, 1);
      assert.equal(res.archivosError.length, 0);

      // Verificamos que se movió a procesados
      assert.equal(existsSync(join(dirEntrada, "factura1.xml")), false);
      assert.equal(db.lotes.size, 1);
      assert.equal(db.registros.size, 1);
    } finally {
      if (existsSync(dirTest)) rmSync(dirTest, { recursive: true, force: true });
    }
  });
});
