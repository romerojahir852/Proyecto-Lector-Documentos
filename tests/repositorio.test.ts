import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RepositorioDocumentos } from "../db/repositorio.ts";
import type { ClienteDb, ResultadoQuery } from "../db/repositorio.ts";

class MockClienteDb implements ClienteDb {
  lotes = new Map<string, Record<string, unknown>>();
  archivos = new Map<string, Record<string, unknown>>();
  registros = new Map<string, Record<string, unknown>>();
  expedientes = new Map<string, Record<string, unknown>>();
  sqlEjecutados: string[] = [];

  private clonarEstado() {
    return {
      lotes: new Map(this.lotes),
      archivos: new Map(this.archivos),
      registros: new Map(this.registros),
      expedientes: new Map(this.expedientes),
    };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<ResultadoQuery<T>> {
    this.sqlEjecutados.push(sql);

    if (sql.includes("INSERT INTO lotes_carga")) {
      const [id, tenantId, etiquetaPeriodo, estado, totalArchivos, procesados] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const existente = this.lotes.get(key);
      const fila = {
        id,
        tenant_id: tenantId,
        etiqueta_periodo: etiquetaPeriodo ?? existente?.etiqueta_periodo ?? null,
        estado,
        total_archivos: totalArchivos,
        procesados,
      };
      this.lotes.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("UPDATE lotes_carga")) {
      const [tenantId, id, estado, totalArchivos, procesados] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const existente = this.lotes.get(key);
      if (!existente) return { rows: [], rowCount: 0 };
      const actualizada = {
        ...existente,
        estado,
        total_archivos: totalArchivos,
        procesados,
      };
      this.lotes.set(key, actualizada);
      return { rows: [actualizada as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO archivos_entrada")) {
      const [
        id,
        tenantId,
        loteId,
        nombreOriginal,
        mimeType,
        tamanoBytes,
        rutaStorage,
        hashSha256,
        estadoCola,
        intentos,
        ultimoError,
      ] = params;
      const key = `${String(tenantId)}|${String(id)}`;
      const fila = {
        id,
        tenant_id: tenantId,
        lote_id: loteId,
        nombre_original: nombreOriginal,
        mime_type: mimeType,
        tamano_bytes: tamanoBytes,
        ruta_storage: rutaStorage,
        hash_sha256: hashSha256,
        estado_cola: estadoCola,
        intentos,
        ultimo_error: ultimoError,
      };
      this.archivos.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("UPDATE archivos_entrada")) {
      const [tenantId, archivoId, estadoCola, intentos, ultimoError] = params;
      const key = `${String(tenantId)}|${String(archivoId)}`;
      const existente = this.archivos.get(key);
      if (!existente) return { rows: [], rowCount: 0 };
      const actualizada = {
        ...existente,
        estado_cola: estadoCola,
        intentos,
        ultimo_error: ultimoError,
      };
      this.archivos.set(key, actualizada);
      return { rows: [actualizada as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO registros_extraidos")) {
      const [
        tenantId,
        loteId,
        archivoId,
        indiceCandidato,
        tipoDocumento,
        fechaDocumento,
        monto,
        identificacion,
        nombreTercero,
        referencia,
        confianza,
        estadoFlujo,
        motivosAlerta,
        datosCrudos,
      ] = params;
      const key = `${String(tenantId)}|${String(archivoId)}|${String(indiceCandidato)}`;
      const fila = {
        tenant_id: tenantId,
        lote_id: loteId,
        archivo_id: archivoId,
        indice_candidato: indiceCandidato,
        tipo_documento: tipoDocumento,
        fecha_documento: fechaDocumento,
        monto,
        identificacion,
        nombre_tercero: nombreTercero,
        referencia,
        confianza,
        estado_flujo: estadoFlujo,
        motivos_alerta: motivosAlerta,
        datos_crudos: datosCrudos,
      };
      this.registros.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO expedientes")) {
      const [
        tenantId,
        identificacion,
        nombreTercero,
        periodo,
        cantidadRegistros,
        montoTotal,
        tienePendientesRevision,
      ] = params;
      const key = `${String(tenantId)}|${String(identificacion)}|${String(periodo)}`;
      const existente = this.expedientes.get(key);
      const fila = {
        tenant_id: tenantId,
        identificacion,
        nombre_tercero: nombreTercero ?? existente?.nombre_tercero ?? null,
        periodo,
        cantidad_registros: cantidadRegistros,
        monto_total: montoTotal,
        tiene_pendientes_revision: tienePendientesRevision,
      };
      this.expedientes.set(key, fila);
      return { rows: [fila as T], rowCount: 1 };
    }

    throw new Error(`Consulta no soportada en MockClienteDb: ${sql}`);
  }

  async transaccion<R>(fn: (tx: ClienteDb) => Promise<R>): Promise<R> {
    const snapshot = this.clonarEstado();
    try {
      return await fn(this);
    } catch (err) {
      this.lotes = snapshot.lotes;
      this.archivos = snapshot.archivos;
      this.registros = snapshot.registros;
      this.expedientes = snapshot.expedientes;
      throw err;
    }
  }
}

describe("RepositorioDocumentos", () => {
  it("exige tenantId obligatorio en todas las operaciones", async () => {
    const repo = new RepositorioDocumentos(new MockClienteDb());

    await assert.rejects(
      () => repo.crearLote({ id: "lote-1", tenantId: "   " }),
      /tenantId es obligatorio/
    );
    await assert.rejects(
      () =>
        repo.actualizarEstadoArchivo({
          tenantId: "",
          archivoId: "arch-1",
          estadoCola: "listo",
          intentos: 1,
        }),
      /tenantId es obligatorio/
    );
  });

  it("crea y actualiza lotes y archivos de forma idempotente por (tenant_id, id)", async () => {
    const db = new MockClienteDb();
    const repo = new RepositorioDocumentos(db);

    await repo.crearLote({
      id: "lote-1",
      tenantId: "tenant-a",
      etiquetaPeriodo: "2026-11",
      totalArchivos: 2,
    });
    const loteActualizado = await repo.actualizarEstadoLote({
      tenantId: "tenant-a",
      loteId: "lote-1",
      estado: "finalizado",
      totalArchivos: 2,
      procesados: 2,
    });

    assert.equal(loteActualizado?.estado, "finalizado");
    assert.equal(loteActualizado?.procesados, 2);

    await repo.registrarArchivoEntrada({
      id: "arch-1",
      tenantId: "tenant-a",
      loteId: "lote-1",
      nombreOriginal: "factura.xml",
      mimeType: "application/xml",
      tamanoBytes: 512,
      rutaStorage: "tenant-a/lote-1/factura.xml",
      hashSha256: "sha-1",
    });

    const archActualizado = await repo.actualizarEstadoArchivo({
      tenantId: "tenant-a",
      archivoId: "arch-1",
      estadoCola: "listo",
      intentos: 1,
      ultimoError: null,
    });

    assert.equal(archActualizado?.estado_cola, "listo");
    assert.equal(db.archivos.size, 1);
  });

  it("evita duplicados en registros_extraidos usando ON CONFLICT (tenant_id, archivo_id, indice_candidato) DO UPDATE", async () => {
    const db = new MockClienteDb();
    const repo = new RepositorioDocumentos(db);

    await repo.guardarRegistroExtraido({
      tenantId: "tenant-a",
      loteId: "lote-1",
      archivoId: "arch-1",
      indiceCandidato: 0,
      tipoDocumento: "factura",
      fechaDocumento: "2026-11-20",
      monto: 100.5,
      identificacion: "1790012345001",
      nombreTercero: "Proveedor Uno",
      referencia: "FAC-001",
      confianza: 0.72,
      estadoFlujo: "revision_rapida",
      motivosAlerta: ["BAJA_CONFIANZA_EXTRACCION"],
      datosCrudos: { intento: 1 },
    });

    // Reprocesamiento del mismo candidato: debe actualizar, no duplicar
    const actualizado = await repo.guardarRegistroExtraido({
      tenantId: "tenant-a",
      loteId: "lote-1",
      archivoId: "arch-1",
      indiceCandidato: 0,
      tipoDocumento: "factura",
      fechaDocumento: "2026-11-20",
      monto: 100.5,
      identificacion: "1790012345001",
      nombreTercero: "Proveedor Uno",
      referencia: "FAC-001",
      confianza: 0.98,
      estadoFlujo: "listo",
      motivosAlerta: [],
      datosCrudos: { intento: 2 },
    });

    assert.equal(db.registros.size, 1);
    assert.equal(actualizado.estado_flujo, "listo");
    assert.equal(actualizado.confianza, 0.98);
    assert.ok(
      db.sqlEjecutados.some((s) =>
        s.includes("ON CONFLICT (tenant_id, archivo_id, indice_candidato) DO UPDATE")
      )
    );
  });

  it("consolida expedientes por (tenant_id, identificacion, periodo) y revierte transacciones si fallan", async () => {
    const db = new MockClienteDb();
    const repo = new RepositorioDocumentos(db);

    await repo.consolidarExpediente({
      tenantId: "tenant-a",
      identificacion: "1790012345001",
      nombreTercero: "Proveedor Uno",
      periodo: "2026-11",
      cantidadRegistros: 1,
      montoTotal: 100.5,
      tienePendientesRevision: true,
    });

    const consolidado = await repo.consolidarExpediente({
      tenantId: "tenant-a",
      identificacion: "1790012345001",
      periodo: "2026-11",
      cantidadRegistros: 2,
      montoTotal: 250.75,
      tienePendientesRevision: false,
    });

    assert.equal(db.expedientes.size, 1);
    assert.equal(consolidado.cantidad_registros, 2);
    assert.equal(consolidado.monto_total, 250.75);
    assert.equal(consolidado.tiene_pendientes_revision, false);

    // Transacción con fallo debe hacer rollback
    await assert.rejects(
      () =>
        repo.ejecutarEnTransaccion("tenant-a", async (repoTx) => {
          await repoTx.crearLote({ id: "lote-rollback", tenantId: "tenant-a" });
          throw new Error("Fallo simulado en transacción");
        }),
      /Fallo simulado en transacción/
    );

    assert.equal(db.lotes.has("tenant-a|lote-rollback"), false);
  });
});
