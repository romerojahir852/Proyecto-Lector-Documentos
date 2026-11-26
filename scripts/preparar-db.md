# Guía de Preparación de Base de Datos (Neon / PostgreSQL / Supabase)

## 1. Variables de entorno

Copia `.env.example` a `.env` y configura tus variables:

```bash
DATABASE_URL=postgresql://usuario:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
OCR_SERVICE_URL=http://127.0.0.1:8000/extraer
DB_CHECK_TENANT_ID=11111111-1111-4111-8111-111111111111
FLOW_TENANT_ID=11111111-1111-4111-8111-111111111111
```

> **Importante:** Mantén `.env` fuera del control de versiones (ya está en `.gitignore`).

> **Nota sobre `OCR_SERVICE_URL`**: Si el microservicio Python OCR no está corriendo
> localmente en el puerto 8000, el flujo real (`npm run flow:run`) detecta
> automáticamente la indisponibilidad vía `/health` y activa un fallback seguro
> sin romper la cola ni generar errores falsos.

---

## 2. Aplicar el Esquema

### Opción A — Script automático (recomendado para Neon / PostgreSQL estándar)

```bash
node --env-file=.env scripts/aplicar-schema.ts
# o mediante npm:
npm run db:migrate
```

Este script aplica `db/002_schema_neon.sql`, el cual:
- Crea las 5 tablas multi-tenant de forma idempotente (`IF NOT EXISTS`).
- Genera los índices de rendimiento y unicidad.
- Habilita RLS con políticas permisivas para acceso server-side (sin `auth.jwt()`).
- Inserta el tenant semilla `11111111-1111-4111-8111-111111111111`.

### Opción B — Supabase SQL Editor (con RLS basado en JWT)

Si usas Supabase con `auth.jwt()`, ejecuta directamente `db/001_schema_multitenant.sql`
en el SQL Editor de Supabase y luego inserta el tenant semilla:

```sql
INSERT INTO tenants (id, nombre, ruc_o_codigo)
VALUES ('11111111-1111-4111-8111-111111111111', 'Estudio Contable Demo', '1790012344001')
ON CONFLICT (id) DO NOTHING;
```

---

## 3. Verificación

1. **Test de conexión a DB (Smoke / Idempotente):**
   ```bash
   node --env-file=.env scripts/probar-db.ts
   # o: npm run db:check
   ```

2. **Flujo documental completo (procesa XML, CSV, PDF de ejemplo):**
   ```bash
   node --env-file=.env scripts/ejecutar-flujo-real.ts
   # o: npm run flow:run
   ```

3. **Pruebas unitarias (100% en memoria, sin DB ni red):**
   ```bash
   npm test
   ```
