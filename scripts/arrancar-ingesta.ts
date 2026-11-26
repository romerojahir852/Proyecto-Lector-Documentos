/**
 * Script de entrada automática de documentos (Daemon / CLI)
 * Puede arrancar:
 *   1. Servidor HTTP REST (POST /api/ingesta)
 *   2. Vigilante de carpeta de entrada (inbox watcher) cada X segundos
 *
 * Uso:
 *   node --env-file=.env scripts/arrancar-ingesta.ts
 */

import { resolve } from "node:path";
import { crearClientePg } from "../db/clientePg.ts";
import { ServicioIngestaDocumental } from "../db/servicioIngesta.ts";
import { crearServidorIngestaHttp } from "../db/servidorHttpIngesta.ts";
import { VigilanteCarpetaEntrada } from "../db/vigilanteCarpeta.ts";

async function main() {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL es obligatoria para arrancar la ingesta automática.");
    process.exit(1);
  }

  const tenantId =
    (process.env.FLOW_TENANT_ID ?? process.env.DB_CHECK_TENANT_ID ?? "").trim() ||
    "11111111-1111-4111-8111-111111111111";

  const ocrUrl = (process.env.OCR_SERVICE_URL ?? "").trim();
  const puertoHttp = Number(process.env.PORT ?? process.env.INGESTA_PORT ?? 3000);
  const carpetaInbox = resolve(process.env.INBOX_DIR ?? "./inbox");
  const intervaloSegundos = Number(process.env.WATCHER_INTERVAL_SEC ?? 10);

  console.log("======================================================================");
  console.log("  INICIANDO SERVICIO DE ENTRADA AUTOMÁTICA DE DOCUMENTOS");
  console.log("======================================================================");
  console.log(`🔗 Conectando a PostgreSQL...`);
  console.log(`🏢 Tenant por defecto: ${tenantId}`);
  console.log(`🔍 OCR Service URL:    ${ocrUrl || "(No configurado - usando fallback)"}`);
  console.log(`📁 Carpeta Inbox:      ${carpetaInbox}`);
  console.log(`🌐 Puerto HTTP:        ${puertoHttp}\n`);

  const db = crearClientePg(databaseUrl);

  const servicio = new ServicioIngestaDocumental({
    db,
    ocrUrl,
  });

  // 1. Iniciar Vigilante de Carpeta
  const vigilante = new VigilanteCarpetaEntrada({
    servicio,
    tenantId,
    carpetaEntrada: carpetaInbox,
  });

  console.log(`✓ Vigilante de carpeta activo (escaneando cada ${intervaloSegundos}s).`);
  setInterval(async () => {
    try {
      const res = await vigilante.procesarArchivosPendientes();
      if (res.archivosDetectados > 0) {
        console.log(
          `[INBOX] Detectados ${res.archivosDetectados} archivo(s). Procesados: ${res.archivosProcesados.length}, Errores: ${res.archivosError.length} (Lote: ${res.loteId})`
        );
      }
    } catch (err) {
      console.error("[INBOX ERROR]", err);
    }
  }, intervaloSegundos * 1000);

  // 2. Iniciar Servidor HTTP
  const servidorHttp = crearServidorIngestaHttp({
    servicio,
    puerto: puertoHttp,
    tenantIdDefault: tenantId,
  });

  servidorHttp.listen(puertoHttp, () => {
    console.log(`✓ Servidor HTTP de ingesta escuchando en http://127.0.0.1:${puertoHttp}`);
    console.log(`  - GET  http://127.0.0.1:${puertoHttp}/health`);
    console.log(`  - POST http://127.0.0.1:${puertoHttp}/api/ingesta`);
    console.log("\nListo para recibir documentos y persistir en Neon automáticamente.");
  });

  const apagar = async () => {
    console.log("\nCerrando servicios...");
    servidorHttp.close();
    await db.cerrar();
    process.exit(0);
  };

  process.on("SIGINT", apagar);
  process.on("SIGTERM", apagar);
}

main().catch((err) => {
  console.error("Error fatal en el servicio de ingesta:", err);
  process.exit(1);
});
