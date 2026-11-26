import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResultRow } from "pg";
import type { ClienteDb, ResultadoQuery } from "./repositorio.ts";

export interface OpcionesClientePg {
  ssl?: boolean | { rejectUnauthorized?: boolean };
  maxConexiones?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export interface ClienteDbPg extends ClienteDb {
  cerrar(): Promise<void>;
}

export interface PoolLike {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface PoolClientLike {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}

function resolverSsl(
  connectionString: string,
  opcionSsl?: boolean | { rejectUnauthorized?: boolean }
): PoolConfig["ssl"] {
  if (opcionSsl === false) return false;
  if (typeof opcionSsl === "object") return opcionSsl;
  if (opcionSsl === true) return { rejectUnauthorized: false };

  const lower = connectionString.toLowerCase();
  if (lower.includes("supabase.") || lower.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function envolverExecutor(executor: Pick<PoolLike | PoolClientLike, "query">): {
  query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<ResultadoQuery<T>>;
} {
  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<ResultadoQuery<T>> {
      const res = await executor.query(sql, [...params]);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },
  };
}

export function adaptarPoolPg(pool: PoolLike): ClienteDbPg {
  const poolExec = envolverExecutor(pool);

  return {
    query: poolExec.query,

    async transaccion<R>(fn: (tx: ClienteDb) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      const txExec = envolverExecutor(client);
      let spCounter = 0;

      const tx: ClienteDb = {
        query: txExec.query,
        async transaccion<SubR>(subFn: (subTx: ClienteDb) => Promise<SubR>): Promise<SubR> {
          spCounter += 1;
          const sp = `sp_${spCounter}`;
          await client.query(`SAVEPOINT ${sp}`);
          try {
            const out = await subFn(tx);
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            return out;
          } catch (err) {
            try {
              await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            } catch {
              // Prioriza propagar el error original
            }
            throw err;
          }
        },
      };

      try {
        await client.query("BEGIN");
        const resultado = await fn(tx);
        await client.query("COMMIT");
        return resultado;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Prioriza propagar el error original
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async cerrar(): Promise<void> {
      await pool.end();
    },
  };
}

export function crearClientePg(
  connectionString?: string,
  opciones?: OpcionesClientePg
): ClienteDbPg {
  const conn = (connectionString ?? process.env.DATABASE_URL ?? "").trim();
  if (!conn) {
    throw new Error("DATABASE_URL o connectionString es obligatorio para crearClientePg.");
  }

  const pool = new Pool({
    connectionString: conn,
    ssl: resolverSsl(conn, opciones?.ssl),
    max: opciones?.maxConexiones ?? 10,
    idleTimeoutMillis: opciones?.idleTimeoutMs ?? 30000,
    connectionTimeoutMillis: opciones?.connectionTimeoutMs ?? 10000,
  });

  return adaptarPoolPg(pool as unknown as PoolLike);
}
