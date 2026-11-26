/**
 * Aplica el esquema de base de datos (002_schema_neon.sql) en la DB configurada
 * en DATABASE_URL. Idempotente: puede ejecutarse múltiples veces.
 *
 * Uso: node --env-file=.env scripts/aplicar-schema.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crearClientePg } from "../db/clientePg.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL no está definida. Configúrala en .env o como variable de entorno.");
    process.exitCode = 1;
    return;
  }

  const sqlPath = resolve(__dirname, "..", "db", "002_schema_neon.sql");
  let sql: string;
  try {
    sql = readFileSync(sqlPath, "utf8");
  } catch (err) {
    console.error(`❌ No se pudo leer ${sqlPath}:`, err);
    process.exitCode = 1;
    return;
  }

  console.log(`📄 Leyendo esquema desde: ${sqlPath}`);
  console.log(`🔗 Conectando a: ${databaseUrl.replace(/\/\/[^@]+@/, "//***@")}`);

  const db = crearClientePg(databaseUrl);

  try {
    await db.query(sql, []);
    console.log("✅ Esquema aplicado correctamente.");

    // Verificar tablas creadas
    const tablas = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      []
    );
    console.log(`\n📋 Tablas en public: ${tablas.rows.map((r) => r.tablename).join(", ")}`);

    // Verificar tenant semilla
    const tenant = await db.query<{ id: string; nombre: string }>(
      "SELECT id, nombre FROM tenants WHERE id = $1",
      ["11111111-1111-4111-8111-111111111111"]
    );
    if (tenant.rows.length > 0) {
      console.log(`✓ Tenant semilla encontrado: ${tenant.rows[0].nombre} (${tenant.rows[0].id})`);
    } else {
      console.warn("⚠ Tenant semilla no encontrado.");
    }
  } catch (err) {
    console.error("❌ Error aplicando esquema:", err);
    process.exitCode = 1;
  } finally {
    await db.cerrar();
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exitCode = 1;
});
