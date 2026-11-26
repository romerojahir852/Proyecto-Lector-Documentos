import { ProcesadorLotes } from "../queue/procesadorLotes.ts";
import type { ArchivoEntradaTrabajo } from "../extractors/types.ts";

async function main(): Promise<void> {
  const tenantId = "tenant-estudio-contable-01";
  const loteId = "lote-2026-11-demo";
  const procesador = new ProcesadorLotes(undefined, {
    maxIntentos: 3,
    umbralConfianzaMinimo: 0.85,
    montoMaximoAlerta: 10000,
  });

  const archivosDemo: ArchivoEntradaTrabajo[] = [
    {
      id: "arch-01",
      tenantId,
      loteId,
      nombreOriginal: "factura_001.xml",
      mimeType: "application/xml",
      tamanoBytes: 512,
      rutaStorage: `${tenantId}/${loteId}/factura_001.xml`,
      hashSha256: "sha256-001",
      contenido: JSON.stringify({
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-15",
        monto: "1,250.40",
        identificacion: "1790012344001",
        nombreTercero: "Distribuidora Andes S.A.",
        referencia: "001-001-000451",
        confianza: 0.99,
      }),
    },
    {
      id: "arch-02",
      tenantId,
      loteId,
      nombreOriginal: "comprobante_002.xml",
      mimeType: "application/xml",
      tamanoBytes: 420,
      rutaStorage: `${tenantId}/${loteId}/comprobante_002.xml`,
      hashSha256: "sha256-002",
      contenido: JSON.stringify({
        tipoDocumento: "comprobante",
        fechaDocumento: "2026-11-18",
        monto: "349,60",
        identificacion: "1790012344001",
        nombreTercero: "Distribuidora Andes S.A.",
        referencia: "TRF-88219",
        confianza: 0.94,
      }),
    },
    {
      id: "arch-03",
      tenantId,
      loteId,
      nombreOriginal: "foto_recibo_borroso.jpg",
      mimeType: "image/jpeg",
      tamanoBytes: 184320,
      rutaStorage: `${tenantId}/${loteId}/foto_recibo_borroso.jpg`,
      hashSha256: "sha256-003",
    },
    {
      id: "arch-04",
      tenantId,
      loteId,
      nombreOriginal: "factura_001_reenviada.xml",
      mimeType: "application/xml",
      tamanoBytes: 512,
      rutaStorage: `${tenantId}/${loteId}/factura_001_reenviada.xml`,
      hashSha256: "sha256-001", // Duplicado exacto
      contenido: JSON.stringify({
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-15",
        monto: "1,250.40",
        identificacion: "1790012344001",
        nombreTercero: "Distribuidora Andes S.A.",
        referencia: "001-001-000451",
        confianza: 0.99,
      }),
    },
    {
      id: "arch-05",
      tenantId,
      loteId,
      nombreOriginal: "fecha_futura.xml",
      mimeType: "application/xml",
      tamanoBytes: 300,
      rutaStorage: `${tenantId}/${loteId}/fecha_futura.xml`,
      hashSha256: "sha256-005",
      contenido: JSON.stringify({
        tipoDocumento: "factura",
        fechaDocumento: "2029-05-01",
        monto: "500.00",
        identificacion: "0991234578001",
        nombreTercero: "Servicios Pacífico",
        referencia: "FAC-900",
        confianza: 0.97,
      }),
    },
  ];

  const resultado = await procesador.procesarLote(tenantId, archivosDemo);

  console.log("=== RESULTADO DE CLASIFICACIÓN POR ARCHIVO ===");
  for (const reg of resultado.registros) {
    console.log(
      `- [${reg.validacion.estadoFlujo.toUpperCase()}] archivo=${reg.archivoId} | id=${reg.validacion.identificacionLimpia ?? "N/A"} | fecha=${reg.validacion.fechaValida ?? "N/A"} | monto=${reg.validacion.montoNormalizado ?? "N/A"} | alertas=${JSON.stringify(reg.validacion.motivosAlerta)}`
    );
  }

  console.log("\n=== EXPEDIENTES AGRUPADOS ===");
  for (const exp of resultado.expedientes) {
    console.log(
      `- ${exp.identificacion} (${exp.nombreTercero ?? "Sin nombre"}) | periodo=${exp.periodo} | registros=${exp.cantidadRegistros} (listos=${exp.cantidadListos}, rev=${exp.cantidadRevisionRapida}) | total=${exp.montoTotal.toFixed(2)} | pendientes=${exp.tienePendientesRevision}`
    );
  }

  console.log("\n=== RESUMEN DEL LOTE ===");
  console.log(JSON.stringify(resultado.resumen, null, 2));
}

main().catch((err) => {
  console.error("Error en simulación:", err);
  process.exitCode = 1;
});
