import type { EstadoCola, EstadoLote } from "../queue/procesadorLotes.ts";
import type { EstadoFlujo } from "../validator/validarRegistro.ts";

export interface ResultadoQuery<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface ClienteDb {
  query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<ResultadoQuery<T>>;
  transaccion<R>(fn: (tx: ClienteDb) => Promise<R>): Promise<R>;
}

export interface CrearLoteInput {
  id: string;
  tenantId: string;
  etiquetaPeriodo?: string | null;
  estado?: "recibido" | EstadoLote;
  totalArchivos?: number;
  procesados?: number;
}

export interface ActualizarEstadoLoteInput {
  tenantId: string;
  loteId: string;
  estado: "recibido" | EstadoLote;
  totalArchivos: number;
  procesados: number;
}

export interface RegistrarArchivoInput {
  id: string;
  tenantId: string;
  loteId: string;
  nombreOriginal: string;
  mimeType: string;
  tamanoBytes: number;
  rutaStorage: string;
  hashSha256: string;
  estadoCola?: EstadoCola;
  intentos?: number;
  ultimoError?: string | null;
}

export interface ActualizarEstadoArchivoInput {
  tenantId: string;
  archivoId: string;
  estadoCola: EstadoCola;
  intentos: number;
  ultimoError?: string | null;
}

export interface GuardarRegistroInput {
  tenantId: string;
  loteId: string;
  archivoId: string;
  indiceCandidato: number;
  tipoDocumento?: string | null;
  fechaDocumento?: string | null;
  monto?: number | null;
  identificacion?: string | null;
  nombreTercero?: string | null;
  referencia?: string | null;
  confianza: number;
  estadoFlujo: EstadoFlujo;
  motivosAlerta: string[];
  datosCrudos: Record<string, unknown>;
}

export interface ConsolidarExpedienteInput {
  tenantId: string;
  identificacion: string;
  nombreTercero?: string | null;
  periodo: string;
  cantidadRegistros: number;
  montoTotal: number;
  tienePendientesRevision: boolean;
}

function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new Error("tenantId es obligatorio para cualquier operación en base de datos.");
  }
  return tenantId.trim();
}

export class RepositorioDocumentos {
  private readonly db: ClienteDb;

  constructor(db: ClienteDb) {
    this.db = db;
  }

  async crearLote(input: CrearLoteInput): Promise<Record<string, unknown>> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      INSERT INTO lotes_carga (id, tenant_id, etiqueta_periodo, estado, total_archivos, procesados)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        etiqueta_periodo = COALESCE(EXCLUDED.etiqueta_periodo, lotes_carga.etiqueta_periodo),
        estado = EXCLUDED.estado,
        total_archivos = EXCLUDED.total_archivos,
        procesados = EXCLUDED.procesados
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      input.id,
      tenantId,
      input.etiquetaPeriodo ?? null,
      input.estado ?? "recibido",
      input.totalArchivos ?? 0,
      input.procesados ?? 0,
    ]);
    return res.rows[0] ?? {};
  }

  async actualizarEstadoLote(
    input: ActualizarEstadoLoteInput
  ): Promise<Record<string, unknown> | null> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      UPDATE lotes_carga
      SET estado = $3,
          total_archivos = $4,
          procesados = $5
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      tenantId,
      input.loteId,
      input.estado,
      input.totalArchivos,
      input.procesados,
    ]);
    return res.rows[0] ?? null;
  }

  async registrarArchivoEntrada(
    input: RegistrarArchivoInput
  ): Promise<Record<string, unknown>> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      INSERT INTO archivos_entrada (
        id, tenant_id, lote_id, nombre_original, mime_type,
        tamano_bytes, ruta_storage, hash_sha256, estado_cola, intentos, ultimo_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        hash_sha256 = EXCLUDED.hash_sha256,
        estado_cola = EXCLUDED.estado_cola,
        intentos = EXCLUDED.intentos,
        ultimo_error = EXCLUDED.ultimo_error
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      input.id,
      tenantId,
      input.loteId,
      input.nombreOriginal,
      input.mimeType,
      input.tamanoBytes,
      input.rutaStorage,
      input.hashSha256,
      input.estadoCola ?? "pendiente",
      input.intentos ?? 0,
      input.ultimoError ?? null,
    ]);
    return res.rows[0] ?? {};
  }

  async actualizarEstadoArchivo(
    input: ActualizarEstadoArchivoInput
  ): Promise<Record<string, unknown> | null> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      UPDATE archivos_entrada
      SET estado_cola = $3,
          intentos = $4,
          ultimo_error = $5
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      tenantId,
      input.archivoId,
      input.estadoCola,
      input.intentos,
      input.ultimoError ?? null,
    ]);
    return res.rows[0] ?? null;
  }

  async guardarRegistroExtraido(
    input: GuardarRegistroInput
  ): Promise<Record<string, unknown>> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      INSERT INTO registros_extraidos (
        tenant_id, lote_id, archivo_id, indice_candidato, tipo_documento,
        fecha_documento, monto, identificacion, nombre_tercero, referencia,
        confianza, estado_flujo, motivos_alerta, datos_crudos
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
      ON CONFLICT (tenant_id, archivo_id, indice_candidato) DO UPDATE SET
        tipo_documento = EXCLUDED.tipo_documento,
        fecha_documento = EXCLUDED.fecha_documento,
        monto = EXCLUDED.monto,
        identificacion = EXCLUDED.identificacion,
        nombre_tercero = EXCLUDED.nombre_tercero,
        referencia = EXCLUDED.referencia,
        confianza = EXCLUDED.confianza,
        estado_flujo = EXCLUDED.estado_flujo,
        motivos_alerta = EXCLUDED.motivos_alerta,
        datos_crudos = EXCLUDED.datos_crudos,
        actualizado_en = now()
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      tenantId,
      input.loteId,
      input.archivoId,
      input.indiceCandidato,
      input.tipoDocumento ?? null,
      input.fechaDocumento ?? null,
      input.monto ?? null,
      input.identificacion ?? null,
      input.nombreTercero ?? null,
      input.referencia ?? null,
      input.confianza,
      input.estadoFlujo,
      JSON.stringify(input.motivosAlerta),
      JSON.stringify(input.datosCrudos),
    ]);
    return res.rows[0] ?? {};
  }

  async consolidarExpediente(
    input: ConsolidarExpedienteInput
  ): Promise<Record<string, unknown>> {
    const tenantId = assertTenantId(input.tenantId);
    const sql = `
      INSERT INTO expedientes (
        tenant_id, identificacion, nombre_tercero, periodo,
        cantidad_registros, monto_total, tiene_pendientes_revision
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, identificacion, periodo) DO UPDATE SET
        nombre_tercero = COALESCE(EXCLUDED.nombre_tercero, expedientes.nombre_tercero),
        cantidad_registros = EXCLUDED.cantidad_registros,
        monto_total = EXCLUDED.monto_total,
        tiene_pendientes_revision = EXCLUDED.tiene_pendientes_revision
      RETURNING *
    `.trim();

    const res = await this.db.query(sql, [
      tenantId,
      input.identificacion,
      input.nombreTercero ?? null,
      input.periodo,
      input.cantidadRegistros,
      Math.round(input.montoTotal * 100) / 100,
      input.tienePendientesRevision,
    ]);
    return res.rows[0] ?? {};
  }

  async ejecutarEnTransaccion<R>(
    tenantId: string,
    fn: (repoTx: RepositorioDocumentos) => Promise<R>
  ): Promise<R> {
    assertTenantId(tenantId);
    return this.db.transaccion(async (tx) => {
      const repoTx = new RepositorioDocumentos(tx);
      return fn(repoTx);
    });
  }
}
