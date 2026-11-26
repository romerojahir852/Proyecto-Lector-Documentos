export type CanalExtraccion = "parser_directo" | "docling_ocr";

export interface ArchivoEntradaTrabajo {
  id: string;
  tenantId: string;
  loteId: string;
  nombreOriginal: string;
  mimeType: string;
  tamanoBytes: number;
  rutaStorage: string;
  hashSha256: string;
  contenido?: Uint8Array | string;
}

export interface CampoExtraidoCandidato {
  tipoDocumento?: string | null;
  fechaDocumento?: string | null;
  monto?: number | string | null;
  identificacion?: string | null;
  nombreTercero?: string | null;
  referencia?: string | null;
  confianza: number;
  datosCrudos: Record<string, unknown>;
}

export interface ResultadoExtraccion {
  canal: CanalExtraccion;
  candidatos: CampoExtraidoCandidato[];
}

export interface ExtractorDocumentos {
  readonly nombre: string;
  readonly canal: CanalExtraccion;
  soporta(mimeType: string, nombreArchivo: string): boolean;
  extraer(archivo: ArchivoEntradaTrabajo): Promise<ResultadoExtraccion>;
}
