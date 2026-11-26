-- Esquema multi-tenant (PostgreSQL / Supabase) para el motor de procesamiento documental

-- 1. Tenants (empresas o estudios contables clientes)
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  ruc_o_codigo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Lotes de carga (cada vez que suben un grupo de archivos/fotos)
CREATE TABLE lotes_carga (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  etiqueta_periodo TEXT, -- ej. "2026-11" o "Lote-01"
  estado TEXT NOT NULL DEFAULT 'recibido', -- recibido | procesando | finalizado | con_errores
  total_archivos INT NOT NULL DEFAULT 0,
  procesados INT NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- 3. Archivos subidos (XML, Excel/CSV, PDF, imágenes/fotos)
CREATE TABLE archivos_entrada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lote_id UUID NOT NULL,
  nombre_original TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL,
  ruta_storage TEXT NOT NULL,
  hash_sha256 TEXT NOT NULL, -- clave para detectar duplicados exactos
  estado_cola TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | procesando | listo | error
  intentos INT NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lote_id) REFERENCES lotes_carga(tenant_id, id) ON DELETE CASCADE
);

-- 4. Registros extraídos y validados (el corazón del motor)
CREATE TABLE registros_extraidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lote_id UUID NOT NULL,
  archivo_id UUID NOT NULL,
  tipo_documento TEXT, -- factura | comprobante | cedula_ruc | formulario | otro
  fecha_documento DATE,
  monto NUMERIC(14, 2),
  identificacion TEXT, -- RUC / cédula / identificador del tercero
  nombre_tercero TEXT,
  referencia TEXT, -- número de documento, transferencia o autorización
  confianza NUMERIC(4, 3) NOT NULL DEFAULT 0.000, -- 0.000 a 1.000
  estado_flujo TEXT NOT NULL DEFAULT 'revision_rapida', -- listo | revision_rapida
  motivos_alerta JSONB NOT NULL DEFAULT '[]'::jsonb, -- ej. ["MONTO_FALTANTE", "BAJA_CONFIANZA"]
  revisado_por_usuario BOOLEAN NOT NULL DEFAULT false,
  datos_crudos JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lote_id) REFERENCES lotes_carga(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, archivo_id) REFERENCES archivos_entrada(tenant_id, id) ON DELETE CASCADE
);

-- 5. Expedientes agrupados (por tenant, período e identificación)
CREATE TABLE expedientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  identificacion TEXT NOT NULL,
  nombre_tercero TEXT,
  periodo TEXT,
  cantidad_registros INT NOT NULL DEFAULT 0,
  monto_total NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  tiene_pendientes_revision BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identificacion, periodo)
);

-- Índices para velocidad y aislamiento por tenant
CREATE INDEX idx_lotes_tenant ON lotes_carga(tenant_id);
CREATE INDEX idx_archivos_tenant_lote ON archivos_entrada(tenant_id, lote_id);
CREATE INDEX idx_archivos_hash_tenant ON archivos_entrada(tenant_id, hash_sha256);
CREATE INDEX idx_registros_tenant_flujo ON registros_extraidos(tenant_id, estado_flujo);
CREATE INDEX idx_registros_tenant_id ON registros_extraidos(tenant_id, identificacion);
CREATE INDEX idx_expedientes_tenant ON expedientes(tenant_id, periodo);

-- Row Level Security (RLS) base: activa RLS en todas las tablas multi-tenant
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes_carga ENABLE ROW LEVEL SECURITY;
ALTER TABLE archivos_entrada ENABLE ROW LEVEL SECURITY;
ALTER TABLE registros_extraidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes ENABLE ROW LEVEL SECURITY;

-- Políticas de aislamiento usando un claim JWT "tenant_id"
CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id::text = auth.jwt() ->> 'tenant_id')
  WITH CHECK (id::text = auth.jwt() ->> 'tenant_id');
CREATE POLICY tenant_isolation_lotes ON lotes_carga
  USING (tenant_id::text = auth.jwt() ->> 'tenant_id')
  WITH CHECK (tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_isolation_archivos ON archivos_entrada
  USING (tenant_id::text = auth.jwt() ->> 'tenant_id')
  WITH CHECK (tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_isolation_registros ON registros_extraidos
  USING (tenant_id::text = auth.jwt() ->> 'tenant_id')
  WITH CHECK (tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_isolation_expedientes ON expedientes
  USING (tenant_id::text = auth.jwt() ->> 'tenant_id')
  WITH CHECK (tenant_id::text = auth.jwt() ->> 'tenant_id');
