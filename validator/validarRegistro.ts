export type EstadoFlujo = "listo" | "revision_rapida";

export interface RegistroCandidato {
  tipoDocumento?: string | null;
  fechaDocumento?: string | null; // formato esperado YYYY-MM-DD
  monto?: number | string | null;
  identificacion?: string | null;
  nombreTercero?: string | null;
  referencia?: string | null;
  confianza: number; // 0 a 1
  hashSha256: string;
}

export interface ContextoValidacion {
  hashesExistentesEnTenant: Set<string>;
  clavesDuplicadoProbable: Set<string>; // ej. `${identificacion}|${fecha}|${monto}|${referencia}`
  umbralConfianzaMinimo?: number; // por defecto 0.85
  montoMaximoAlerta?: number; // opcional: umbral operativo para revisar
  permitirMontoCero?: boolean; // útil para retenciones/notas/comprobantes en 0.00
}

export interface ResultadoValidacion {
  estadoFlujo: EstadoFlujo;
  motivosAlerta: string[];
  montoNormalizado: number | null;
  identificacionLimpia: string | null;
  fechaValida: string | null;
}

export interface ResultadoIdentificacion {
  valor: string | null;
  formatoDudoso: boolean;
  digitoVerificadorInvalido: boolean;
}

function esProvinciaEcuatorianaValida(codigo: string): boolean {
  const prov = Number(codigo);
  return (prov >= 1 && prov <= 24) || prov === 30;
}

function verificarModulo10Cedula(digitos: string): boolean {
  const coef = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let prod = Number(digitos[i]) * coef[i];
    if (prod >= 10) prod -= 9;
    suma += prod;
  }
  const verificador = (10 - (suma % 10)) % 10;
  return verificador === Number(digitos[9]);
}

function verificarModulo11(digitos: string, coef: number[], posVerificador: number): boolean {
  let suma = 0;
  for (let i = 0; i < coef.length; i++) {
    suma += Number(digitos[i]) * coef[i];
  }
  const residuo = suma % 11;
  const verificador = residuo === 0 ? 0 : 11 - residuo;
  if (verificador === 10) return false;
  return verificador === Number(digitos[posVerificador]);
}

export function analizarIdentificacion(raw?: string | null): ResultadoIdentificacion {
  if (!raw) {
    return { valor: null, formatoDudoso: false, digitoVerificadorInvalido: false };
  }
  const limpia = raw.replace(/[^0-9A-Za-z]/g, "").trim().toUpperCase();
  if (limpia.length < 6) {
    return { valor: null, formatoDudoso: false, digitoVerificadorInvalido: false };
  }

  const esSoloDigitos = /^[0-9]+$/.test(limpia);
  if (esSoloDigitos) {
    // Estándar habitual Ecuador: cédula (10) o RUC (13)
    if (limpia.length !== 10 && limpia.length !== 13) {
      return { valor: limpia, formatoDudoso: true, digitoVerificadorInvalido: false };
    }

    if (!esProvinciaEcuatorianaValida(limpia.slice(0, 2))) {
      return { valor: limpia, formatoDudoso: true, digitoVerificadorInvalido: false };
    }

    const tercerDigito = Number(limpia[2]);

    if (limpia.length === 10) {
      if (tercerDigito > 5) {
        return { valor: limpia, formatoDudoso: true, digitoVerificadorInvalido: false };
      }
      const valido = verificarModulo10Cedula(limpia);
      return {
        valor: limpia,
        formatoDudoso: false,
        digitoVerificadorInvalido: !valido,
      };
    }

    // Longitud 13 (RUC)
    const establecimiento = limpia.slice(10, 13);
    if (establecimiento === "000") {
      return { valor: limpia, formatoDudoso: true, digitoVerificadorInvalido: false };
    }

    if (tercerDigito <= 5) {
      const valido = verificarModulo10Cedula(limpia.slice(0, 10));
      return {
        valor: limpia,
        formatoDudoso: false,
        digitoVerificadorInvalido: !valido,
      };
    }

    if (tercerDigito === 6) {
      const valido = verificarModulo11(limpia, [3, 2, 7, 6, 5, 4, 3, 2], 8);
      return {
        valor: limpia,
        formatoDudoso: false,
        digitoVerificadorInvalido: !valido,
      };
    }

    if (tercerDigito === 9) {
      const valido = verificarModulo11(limpia, [4, 3, 2, 7, 6, 5, 4, 3, 2], 9);
      return {
        valor: limpia,
        formatoDudoso: false,
        digitoVerificadorInvalido: !valido,
      };
    }

    return { valor: limpia, formatoDudoso: true, digitoVerificadorInvalido: false };
  }

  // Identificadores alfanuméricos (ej. pasaporte/exterior): mínimo 6, máximo 20
  const formatoDudoso = limpia.length > 20;
  return { valor: limpia, formatoDudoso, digitoVerificadorInvalido: false };
}

export function limpiarIdentificacion(raw?: string | null): string | null {
  return analizarIdentificacion(raw).valor;
}

export function normalizarMonto(
  raw?: number | string | null,
  permitirCero = false
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let texto = String(raw).trim().replace(/\s+/g, "");
  if (texto.includes(",") && texto.includes(".")) {
    if (texto.lastIndexOf(",") > texto.lastIndexOf(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  } else if (texto.includes(",")) {
    if (/^[^,]+,\d{1,2}$/.test(texto)) {
      texto = texto.replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  }
  const num = Number(texto);
  if (!Number.isFinite(num)) return null;
  if (permitirCero ? num < 0 : num <= 0) return null;
  return Math.round(num * 100) / 100;
}

export function validarFechaISO(raw?: string | null): string | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const fecha = new Date(Date.UTC(year, month - 1, day));
  if (
    fecha.getUTCFullYear() !== year ||
    fecha.getUTCMonth() !== month - 1 ||
    fecha.getUTCDate() !== day
  ) {
    return null;
  }
  const ahora = new Date();
  const mananaUtc = Date.UTC(
    ahora.getUTCFullYear(),
    ahora.getUTCMonth(),
    ahora.getUTCDate() + 1,
    23,
    59,
    59,
    999
  );
  if (fecha.getTime() > mananaUtc) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function generarClaveDuplicadoProbable(
  identificacionLimpia: string,
  fechaValida: string,
  montoNormalizado: number,
  referencia?: string | null
): string {
  return `${identificacionLimpia}|${fechaValida}|${montoNormalizado.toFixed(2)}|${(referencia ?? "").trim().toUpperCase()}`;
}

export function validarYClasificarRegistro(
  cand: RegistroCandidato,
  ctx: ContextoValidacion
): ResultadoValidacion {
  const motivosAlerta: string[] = [];
  const umbral = ctx.umbralConfianzaMinimo ?? 0.85;

  const infoId = analizarIdentificacion(cand.identificacion);
  const identificacionLimpia = infoId.valor;
  const montoNormalizado = normalizarMonto(cand.monto, Boolean(ctx.permitirMontoCero));
  const fechaValida = validarFechaISO(cand.fechaDocumento);

  if (!identificacionLimpia) {
    motivosAlerta.push("IDENTIFICACION_FALTANTE_O_INVALIDA");
  } else {
    if (infoId.formatoDudoso) {
      motivosAlerta.push("IDENTIFICACION_FORMATO_DUDOSO");
    }
    if (infoId.digitoVerificadorInvalido) {
      motivosAlerta.push("IDENTIFICACION_DIGITO_VERIFICADOR_INVALIDO");
    }
  }

  if (montoNormalizado === null) motivosAlerta.push("MONTO_FALTANTE_O_INVALIDO");
  if (!fechaValida) motivosAlerta.push("FECHA_FALTANTE_O_INVALIDA");
  if (!cand.referencia || cand.referencia.trim().length < 2) {
    motivosAlerta.push("REFERENCIA_FALTANTE");
  }
  if (
    typeof cand.confianza !== "number" ||
    !Number.isFinite(cand.confianza) ||
    cand.confianza < 0 ||
    cand.confianza > 1 ||
    cand.confianza < umbral
  ) {
    motivosAlerta.push("BAJA_CONFIANZA_EXTRACCION");
  }
  if (ctx.hashesExistentesEnTenant.has(cand.hashSha256)) {
    motivosAlerta.push("ARCHIVO_DUPLICADO_EXACTO");
  }
  if (identificacionLimpia && fechaValida && montoNormalizado !== null) {
    const clave = generarClaveDuplicadoProbable(
      identificacionLimpia,
      fechaValida,
      montoNormalizado,
      cand.referencia
    );
    if (ctx.clavesDuplicadoProbable.has(clave)) {
      motivosAlerta.push("REGISTRO_DUPLICADO_PROBABLE");
    }
  }
  if (
    ctx.montoMaximoAlerta !== undefined &&
    montoNormalizado !== null &&
    montoNormalizado >= ctx.montoMaximoAlerta
  ) {
    motivosAlerta.push("SUPERA_UMBRAL_REVISION");
  }

  return {
    estadoFlujo: motivosAlerta.length === 0 ? "listo" : "revision_rapida",
    motivosAlerta,
    montoNormalizado,
    identificacionLimpia,
    fechaValida,
  };
}
