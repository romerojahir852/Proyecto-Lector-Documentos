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

  it("rechaza montos vacíos, cero (por defecto), negativos o no numéricos", () => {
    assert.equal(normalizarMonto(null), null);
    assert.equal(normalizarMonto(""), null);
    assert.equal(normalizarMonto("0"), null);
    assert.equal(normalizarMonto("0.00", true), 0);
    assert.equal(normalizarMonto("-45.00"), null);
    assert.equal(normalizarMonto("-45.00", true), null);
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
        identificacion: "1790012344001",
        referencia: "FAC-001-000123",
        confianza: 0.96,
        hashSha256: "hash-limpio-1",
      },
      crearContextoBase()
    );

    assert.equal(res.estadoFlujo, "listo");
    assert.deepEqual(res.motivosAlerta, []);
    assert.equal(res.montoNormalizado, 1250.75);
    assert.equal(res.identificacionLimpia, "1790012344001");
    assert.equal(res.fechaValida, "2026-11-20");
  });

  it("envía a 'revision_rapida' cuando la confianza OCR es menor a 0.85", () => {
    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "comprobante",
        fechaDocumento: "2026-11-20",
        monto: 45.2,
        identificacion: "0991234578001",
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
        identificacion: "1790012344001",
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
      generarClaveDuplicadoProbable("1790012344001", "2026-11-20", 250.0, "FAC-003")
    );

    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: "250,00",
        identificacion: "1790012344001",
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
        identificacion: "1790012344001",
        referencia: "FAC-GRANDE",
        confianza: 0.99,
        hashSha256: "hash-grande",
      },
      ctx
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.ok(res.motivosAlerta.includes("SUPERA_UMBRAL_REVISION"));
  });

  it("marca IDENTIFICACION_FORMATO_DUDOSO si es numérica pero no tiene 10 ni 13 dígitos", () => {
    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 120,
        identificacion: "12345678",
        referencia: "FAC-009",
        confianza: 0.99,
        hashSha256: "hash-id-dudosa",
      },
      crearContextoBase()
    );

    assert.equal(res.estadoFlujo, "revision_rapida");
    assert.equal(res.identificacionLimpia, "12345678");
    assert.ok(res.motivosAlerta.includes("IDENTIFICACION_FORMATO_DUDOSO"));
  });

  it("detecta dígito verificador inválido en cédula y RUC ecuatoriano", () => {
    const cedulaMala = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 50,
        identificacion: "1710034069", // dígito correcto es 5
        referencia: "FAC-CED",
        confianza: 0.99,
        hashSha256: "hash-ced-mala",
      },
      crearContextoBase()
    );
    assert.equal(cedulaMala.estadoFlujo, "revision_rapida");
    assert.ok(cedulaMala.motivosAlerta.includes("IDENTIFICACION_DIGITO_VERIFICADOR_INVALIDO"));

    const rucMalo = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 50,
        identificacion: "1790012345001", // dígito correcto es 4
        referencia: "FAC-RUC",
        confianza: 0.99,
        hashSha256: "hash-ruc-malo",
      },
      crearContextoBase()
    );
    assert.equal(rucMalo.estadoFlujo, "revision_rapida");
    assert.ok(rucMalo.motivosAlerta.includes("IDENTIFICACION_DIGITO_VERIFICADOR_INVALIDO"));

    const rucPublicoValido = validarYClasificarRegistro(
      {
        tipoDocumento: "factura",
        fechaDocumento: "2026-11-20",
        monto: 50,
        identificacion: "1760001550001",
        referencia: "FAC-PUB",
        confianza: 0.99,
        hashSha256: "hash-ruc-pub",
      },
      crearContextoBase()
    );
    assert.equal(rucPublicoValido.estadoFlujo, "listo");
  });

  it("acepta monto 0.00 cuando permitirMontoCero está activo", () => {
    const ctx = crearContextoBase();
    ctx.permitirMontoCero = true;

    const res = validarYClasificarRegistro(
      {
        tipoDocumento: "comprobante",
        fechaDocumento: "2026-11-20",
        monto: "0.00",
        identificacion: "1710034065",
        referencia: "RET-001",
        confianza: 0.99,
        hashSha256: "hash-cero",
      },
      ctx
    );

    assert.equal(res.estadoFlujo, "listo");
    assert.equal(res.montoNormalizado, 0);
  });
});
