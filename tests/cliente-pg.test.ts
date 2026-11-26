import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptarPoolPg, crearClientePg } from "../db/clientePg.ts";
import type { PoolClientLike, PoolLike } from "../db/clientePg.ts";

describe("clientePg", () => {
  it("exige DATABASE_URL o connectionString en crearClientePg", () => {
    const anterior = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.throws(() => crearClientePg(""), /DATABASE_URL o connectionString es obligatorio/);
    } finally {
      if (anterior !== undefined) process.env.DATABASE_URL = anterior;
    }
  });

  it("ejecuta BEGIN, COMMIT y libera el cliente en transacción exitosa", async () => {
    const eventos: string[] = [];
    let liberado = false;

    const clientMock: PoolClientLike = {
      async query(text: string) {
        eventos.push(text);
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
      release() {
        liberado = true;
      },
    };

    const poolMock: PoolLike = {
      async query(text: string) {
        eventos.push(`pool:${text}`);
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return clientMock;
      },
      async end() {
        eventos.push("pool:end");
      },
    };

    const db = adaptarPoolPg(poolMock);
    const res = await db.transaccion(async (tx) => {
      await tx.query("SELECT 1", []);
      return "ok";
    });

    assert.equal(res, "ok");
    assert.deepEqual(eventos, ["BEGIN", "SELECT 1", "COMMIT"]);
    assert.equal(liberado, true);

    await db.cerrar();
    assert.ok(eventos.includes("pool:end"));
  });

  it("ejecuta ROLLBACK y libera el cliente en finally cuando la transacción falla", async () => {
    const eventos: string[] = [];
    let liberado = false;

    const clientMock: PoolClientLike = {
      async query(text: string) {
        eventos.push(text);
        if (text === "INSERT FAIL") {
          throw new Error("Error SQL simulado");
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        liberado = true;
      },
    };

    const poolMock: PoolLike = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return clientMock;
      },
      async end() {},
    };

    const db = adaptarPoolPg(poolMock);

    await assert.rejects(
      () =>
        db.transaccion(async (tx) => {
          await tx.query("INSERT FAIL", []);
        }),
      /Error SQL simulado/
    );

    assert.deepEqual(eventos, ["BEGIN", "INSERT FAIL", "ROLLBACK"]);
    assert.equal(liberado, true);
  });

  it("soporta scripts multi-sentencia que retornan arrays de resultados sin fallar", async () => {
    const poolMock: PoolLike = {
      async query() {
        return [
          { rows: undefined, rowCount: undefined },
          { rows: [{ id: 1 }], rowCount: 1 },
        ];
      },
      async connect() {
        throw new Error("No necesario");
      },
      async end() {},
    };

    const db = adaptarPoolPg(poolMock);
    const res = await db.query("CREATE TABLE a; CREATE TABLE b; SELECT * FROM b;", []);
    assert.deepEqual(res.rows, [{ id: 1 }]);
    assert.equal(res.rowCount, 1);
  });
});
