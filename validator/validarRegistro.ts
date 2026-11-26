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
}

export interface ResultadoValidacion {
  estadoFlujo: EstadoFlujo;
  motivosAlerta: string[];
  montoNormalizado: number | null;
  identificacionLimpia: string | null;
  fechaValida: string | null;
}

export function limpiarIdentificacion(raw?: string | null): string | null {
  if (!raw) return null;
  const limpia = raw.replace(/[^0-9A-Za-z]/g, "").trim().toUpperCase();
  return limpia.length >= 6 ? limpia : null;
}

export function normalizarMonto(raw?: number | string | null): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let texto = String(raw).trim().replace(/\s+/g, "");
  // Maneja formatos como "1,234.56" o "1.234,56"
  if (texto.includes(",") && texto.includes(".")) {
    if (texto.lastIndexOf(",") > texto.lastIndexOf(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  } else if (texto.includes(",")) {
    // Si tiene una sola coma y 1-2 decimales al final, tratar como decimal
    if (/^[^,]+,\d{1,2}$/.test(texto)) {
      texto = texto.replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  }
  const num = Number(texto);
  if (!Number.isFinite(num) || num <= 0) return null;
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
  // Evita fechas futuras absurdas (más de 1 día adelante respecto a hoy UTC)
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

  const identificacionLimpia = limpiarIdentificacion(cand.identificacion);
  const montoNormalizado = normalizarMonto(cand.monto);
  const fechaValida = validarFechaISO(cand.fechaDocumento);

  if (!identificacionLimpia) {
    motivosAlerta.push("IDENTIFICACION_FALTANTE_O_INVALIDA");
  }
  if (montoNormalizado === null) {
    motivosAlerta.push("MONTO_FALTANTE_O_INVALIDO");
  }
  if (!fechaValida) {
    motivosAlerta.push("FECHA_FALTANTE_O_INVALIDA");
  }
  if (!cand.referencia || cand.referencia.trim().length < 2) {
    motivosAlerta.push("REFERENCIA_FALTANTE");
  }
  if (
    typeof cand.confianza !== "number" ||
    Number.isNaN(cand.confianza) ||
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

  const estadoFlujo: EstadoFlujo =
    motivosAlerta.length === 0 ? "listo" : "revision_rapida";

  return {
    estadoFlujo,
    motivosAlerta,
    montoNormalizado,
    identificacionLimpia,
    fechaValida,
  };
}
