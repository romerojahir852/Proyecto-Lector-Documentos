import { crearClientePg } from "../db/clientePg.ts";
import { RepositorioDocumentos } from "../db/repositorio.ts";

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.log("DATABASE_URL no está definida. Omitiendo prueba de integración PostgreSQL.");
    return;
  }

  const db = crearClientePg(databaseUrl);
  const repo = new RepositorioDocumentos(db);

  try {
    const ping = await db.query<{ ok: number }>("SELECT 1 AS ok", []);
    console.log("Conexión PostgreSQL verificada:", ping.rows[0]);

    const tenantPrueba = process.env.DB_CHECK_TENANT_ID?.trim();
    if (!tenantPrueba) {
      console.log(
        "Conexión OK. Define DB_CHECK_TENANT_ID (UUID de un tenant existente) si deseas probar el flujo idempotente completo."
      );
      return;
    }

    const loteId = "00000000-0000-4000-8000-000000000001";
    const archivoId = "00000000-0000-4000-8000-000000000002";

    await repo.ejecutarEnTransaccion(tenantPrueba, async (repoTx) => {
      await repoTx.crearLote({
        id: loteId,
        tenantId: tenantPrueba,
        etiquetaPeriodo: "2026-11",
        estado: "procesando",
        totalArchivos: 1,
        procesados: 0,
      });

      await repoTx.registrarArchivoEntrada({
        id: archivoId,
        tenantId: tenantPrueba,
        loteId,
        nombreOriginal: "db_check_smoke.xml",
        mimeType: "application/xml",
        tamanoBytes: 128,
        rutaStorage: `${tenantPrueba}/${loteId}/db_check_smoke.xml`,
        hashSha256: "db-check-smoke-sha256",
        estadoCola: "listo",
        intentos: 1,
      });

      await repoTx.guardarRegistroExtraido({
        tenantId: tenantPrueba,
        loteId,
        archivoId,
        indiceCandidato: 0,
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 100.0,
        identificacion: "1790012344001",
        nombreTercero: "Prueba Idempotente S.A.",
        referencia: "CHK-001",
        confianza: 0.99,
        estadoFlujo: "listo",
        motivosAlerta: [],
        datosCrudos: { origen: "db:check" },
      });

      await repoTx.consolidarExpediente({
        tenantId: tenantPrueba,
        identificacion: "1790012344001",
        nombreTercero: "Prueba Idempotente S.A.",
        periodo: "2026-11",
        cantidadRegistros: 1,
        montoTotal: 100.0,
        tienePendientesRevision: false,
      });

      await repoTx.actualizarEstadoLote({
        tenantId: tenantPrueba,
        loteId,
        estado: "finalizado",
        totalArchivos: 1,
        procesados: 1,
      });
    });

    console.log("Operación idempotente verificada correctamente para tenant:", tenantPrueba);
  } finally {
    await db.cerrar();
    console.log("Pool PostgreSQL cerrado limpiamente.");
  }
}

main().catch((err) => {
  console.error("Error en db:check:", err);
  process.exitCode = 1;
});
