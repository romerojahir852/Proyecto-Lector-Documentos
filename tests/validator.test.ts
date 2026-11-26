import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generarClaveDuplicadoProbable,
  normalizarMonto,
  validarFechaISO,
  validarYClasificarRegistro,
} from "../validator/validarRegistro.ts";
import type { ContextoValidacion } from "../validator/validarRegistro.ts";

function crearContextoBase(): ContextoValidacion {
  return {
    hashesExistentesEnTenant: new Set<string>(),
    clavesDuplicadoProbable: new Set<string>(),
  };
}

describe("normalizarMonto", () => {
  it("maneja formatos con coma y punto correctamente", () => {
    assert.equal(normalizarMonto("1,234.56"), 1234.56);
    assert.equal(normalizarMonto("1.234,56"), 1234.56);
    assert.equal(normalizarMonto("125,50"), 125.5);
    assert.equal(normalizarMonto("99.9"), 99.9);
    assert.equal(normalizarMonto(1500), 1500);
  });

  it("rechaza montos vacíos, cero, negativos o no numéricos", () => {
    assert.equal(normalizarMonto(null), null);
    assert.equal(normalizarMonto(""), null);
    assert.equal(normalizarMonto("0"), null);
    assert.equal(normalizarMonto("-45.00"), null);
    assert.equal(normalizarMonto("abc"), null);
  });
});

describe("validarFechaISO", () => {
  it("acepta fechas ISO válidas en rango", () => {
    assert.equal(validarFechaISO("2026-11-20"), "2026-11-20");
    assert.equal(validarFechaISO("2024-02-29"), "2024-02-29");
  });

  it("rechaza fechas inválidas o futuras", () => {
    assert.equal(validarFechaISO("2026-02-30"), null);
    assert.equal(validarFechaISO("2026-13-01"), null);
    assert.equal(validarFechaISO("1999-12-31"), null);
    assert.equal(validarFechaISO("2099-01-01"), null);
    assert.equal(validarFechaISO("20/11/2026"), null);
  });
});

describe("validarYClasificarRegistro", () => {
  it("clasifica como 'listo' un registro limpio y completo", () => {
    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: "1,250.75",
        identificacion: "1790012345001",
        referencia: "FAC-001-000123",
        confianza: 0.96,
        hashSha256: "hash-limpio-1",
      },
      crearContextoBase()
    );

    assert.equal(res.estadoFlujo, "listo");
    assert.deepEqual(res.motivosAlerta, []);
    assert.equal(res.montoNormalizado, 1250.75);
    assert.equal(res.identificacionLimpia, "1790012345001");
    assert.equal(res.fechaValida, "2026-11-20");
  });

  it("envía a 'revision_rapida' cuando la confianza OCR es menor a 0.85", () => {
    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "comprobante",
        fechaDocumento: "2026-11-20",
        monto: 45.2,
        identificacion: "0991234567001",
        referencia: "TRF-9988",
        confianza: 0.84,
        hashSha256: "hash-ocr-bajo",
      },
      crearContextoBase()
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.ok(res.motivosAlerta.includes("BAJA_CONFIANZA_EXTRACCION"));
  });

  it("detecta duplicado exacto por hash SHA-256", () => {
    const ctx = crearContextoBase();
    ctx.hashesExistentesEnTenant.add("hash-existente");

    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 100,
        identificacion: "1790012345001",
        referencia: "FAC-002",
        confianza: 0.99,
        hashSha256: "hash-existente",
      },
      ctx
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.ok(res.motivosAlerta.includes("ARCHIVO_DUPLICADO_EXACTO"));
  });

  it("detecta duplicado probable aunque cambie el hash del archivo", () => {
    const ctx = crearContextoBase();
    ctx.clavesDuplicadoProbable.add(
      generarClaveDuplicadoProbable("1790012345001", "2026-11-20", 250.0, "FAC-003")
    );

    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: "250,00",
        identificacion: "1790012345001",
        referencia: "fac-003",
        confianza: 0.95,
        hashSha256: "hash-distinto-foto-reimpresa",
      },
      ctx
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.ok(res.motivosAlerta.includes("REGISTRO_DUPLICADO_PROBABLE"));
  });

  it("marca alerta cuando supera el montoMaximoAlerta configurado", () => {
    const ctx = crearContextoBase();
    ctx.montoMaximoAlerta = 5000;

    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 5000,
        identificacion: "1790012345001",
        referencia: "FAC-GRANDE",
        confianza: 0.99,
        hashSha256: "hash-grande",
      },
      ctx
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.ok(res.motivosAlerta.includes("SUPERA_UMBRAL_REVISION"));
  });
});
