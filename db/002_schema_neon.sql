-- ============================================================================
-- Esquema multi-tenant para PostgreSQL estándar (Neon / local)
-- Compatible con el motor de procesamiento documental
-- NO depende de auth.jwt() ni funciones de Supabase
-- Idempotente: puede ejecutarse múltiples veces sin error
-- ============================================================================

-- 1. Tenants (empresas o estudios contables clientes)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  ruc_o_codigo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Lotes de carga (cada vez que suben un grupo de archivos/fotos)
CREATE TABLE IF NOT EXISTS lotes_carga (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  etiqueta_periodo TEXT,
  estado TEXT NOT NULL DEFAULT 'recibido',
  total_archivos INT NOT NULL DEFAULT 0,
  procesados INT NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- 3. Archivos subidos (XML, Excel/CSV, PDF, imágenes/fotos)
CREATE TABLE IF NOT EXISTS archivos_entrada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lote_id UUID NOT NULL,
  nombre_original TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL,
  ruta_storage TEXT NOT NULL,
  hash_sha256 TEXT NOT NULL,
  estado_cola TEXT NOT NULL DEFAULT 'pendiente',
  intentos INT NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lote_id) REFERENCES lotes_carga(tenant_id, id) ON DELETE CASCADE
);

-- 4. Registros extraídos y validados (el corazón del motor)
CREATE TABLE IF NOT EXISTS registros_extraidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lote_id UUID NOT NULL,
  archivo_id UUID NOT NULL,
  indice_candidato INT NOT NULL DEFAULT 0,
  tipo_documento TEXT,
  fecha_documento DATE,
  monto NUMERIC(14, 2),
  identificacion TEXT,
  nombre_tercero TEXT,
  referencia TEXT,
  confianza NUMERIC(4, 3) NOT NULL DEFAULT 0.000,
  estado_flujo TEXT NOT NULL DEFAULT 'revision_rapida',
  motivos_alerta JSONB NOT NULL DEFAULT '[]'::jsonb,
  revisado_por_usuario BOOLEAN NOT NULL DEFAULT false,
  datos_crudos JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lote_id) REFERENCES lotes_carga(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, archivo_id) REFERENCES archivos_entrada(tenant_id, id) ON DELETE CASCADE
);

-- 5. Expedientes agrupados (por tenant, período e identificación)
CREATE TABLE IF NOT EXISTS expedientes (
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

-- ── Índices (CREATE INDEX IF NOT EXISTS para idempotencia) ────────────────────

CREATE INDEX IF NOT EXISTS idx_lotes_tenant
  ON lotes_carga(tenant_id);

CREATE INDEX IF NOT EXISTS idx_archivos_tenant_lote
  ON archivos_entrada(tenant_id, lote_id);

CREATE INDEX IF NOT EXISTS idx_archivos_hash_tenant
  ON archivos_entrada(tenant_id, hash_sha256);

CREATE INDEX IF NOT EXISTS idx_registros_tenant_flujo
  ON registros_extraidos(tenant_id, estado_flujo);

CREATE INDEX IF NOT EXISTS idx_registros_tenant_id
  ON registros_extraidos(tenant_id, identificacion);

CREATE UNIQUE INDEX IF NOT EXISTS uq_registros_tenant_archivo_idx
  ON registros_extraidos(tenant_id, archivo_id, indice_candidato);

CREATE INDEX IF NOT EXISTS idx_expedientes_tenant
  ON expedientes(tenant_id, periodo);

-- ── RLS: habilitado pero con políticas permisivas para acceso server-side ────
-- En Neon/PostgreSQL estándar no usamos auth.jwt(). El motor accede como
-- superuser o rol con permisos, así que las policies permiten todo.
-- Para producción multi-tenant real, activar RLS con current_setting('app.tenant_id').

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes_carga ENABLE ROW LEVEL SECURITY;
ALTER TABLE archivos_entrada ENABLE ROW LEVEL SECURITY;
ALTER TABLE registros_extraidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes ENABLE ROW LEVEL SECURITY;

-- Políticas permisivas para el owner/superuser (el motor backend)
DO $$ BEGIN
  -- tenants
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'allow_all_tenants') THEN
    EXECUTE 'CREATE POLICY allow_all_tenants ON tenants FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  -- lotes_carga
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'allow_all_lotes') THEN
    EXECUTE 'CREATE POLICY allow_all_lotes ON lotes_carga FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  -- archivos_entrada
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'allow_all_archivos') THEN
    EXECUTE 'CREATE POLICY allow_all_archivos ON archivos_entrada FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  -- registros_extraidos
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'allow_all_registros') THEN
    EXECUTE 'CREATE POLICY allow_all_registros ON registros_extraidos FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  -- expedientes
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'allow_all_expedientes') THEN
    EXECUTE 'CREATE POLICY allow_all_expedientes ON expedientes FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ── Tenant semilla de demo ───────────────────────────────────────────────────

INSERT INTO tenants (id, nombre, ruc_o_codigo)
VALUES ('11111111-1111-4111-8111-111111111111', 'Estudio Contable Demo', '1790012344001')
ON CONFLICT (id) DO NOTHING;
