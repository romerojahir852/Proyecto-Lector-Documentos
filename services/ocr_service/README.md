# Microservicio OCR Documental (`services/ocr_service`)

Microservicio HTTP en Python (FastAPI + uvicorn) desacoplado del motor principal en TypeScript. Cumple exactamente el contrato JSON esperado por `ClienteHttpExtraccionDocumental` (`extractors/clienteHttpOcr.ts`).

## 1. Instalación de dependencias

Desde la raíz del repositorio:

```bash
cd services/ocr_service
python -m venv .venv
```

Activar el entorno virtual e instalar `requirements.txt`:

- **Windows (PowerShell):**
  ```powershell
  .\.venv\Scripts\Activate.ps1
  pip install -r requirements.txt
  ```
- **Linux / macOS:**
  ```bash
  source .venv/bin/activate
  pip install -r requirements.txt
  ```

### Conectar Docling o PaddleOCR (opcional)

Por defecto (`OCR_BACKEND=auto`), si ni `docling` ni `paddleocr` están instalados, el gancho `extraer_con_motor_documental(...)` usa el adaptador `base` de forma segura sin romper el servicio y devuelve confianza `< 0.85` para que el validador determinista lo envíe a `revision_rapida`.

Para activar un motor OCR real:

```bash
# Opción A: Docling
pip install docling
$env:OCR_BACKEND = "docling"

# Opción B: PaddleOCR
pip install paddleocr
$env:OCR_BACKEND = "paddleocr"
```

## 2. Levantar el servidor en `http://127.0.0.1:8000`

```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

## 3. Probar `/health` y `/extraer`

### `GET /health`

```bash
curl http://127.0.0.1:8000/health
```

Respuesta esperada:

```json
{
  "status": "ok",
  "motor": "base"
}
```

### `POST /extraer` con archivo (`multipart/form-data`)

```bash
echo "FACTURA RUC: 1790012344001 FECHA: 2026-11-20 TOTAL: 125.50 REF: FAC-001" > muestra.txt
curl -X POST http://127.0.0.1:8000/extraer \
  -F "tenantId=tenant-demo" \
  -F "archivoId=arch-demo-01" \
  -F "file=@muestra.txt"
```

### `POST /extraer` con JSON (contrato de `ClienteHttpExtraccionDocumental`)

```bash
curl -X POST http://127.0.0.1:8000/extraer \
  -H "Content-Type: application/json" \
  -d '{
    "archivoId": "arch-01",
    "tenantId": "tenant-demo",
    "loteId": "lote-01",
    "nombreOriginal": "factura.pdf",
    "mimeType": "application/pdf",
    "tamanoBytes": 68,
    "rutaStorage": "tenant-demo/lote-01/factura.pdf",
    "hashSha256": "demo-sha256",
    "contenidoBase64": "RkFDVFVSQSBSVUM6IDE3OTAwMTIzNDQwMDEgRkVDSEE6IDIwMjYtMTEtMjAgVE9UQUw6IDEyNS41MCBSRUY6IEZBQy0wMDE="
  }'
```

## 4. Conectar desde el motor TypeScript

```ts
import { ClienteHttpExtraccionDocumental } from "../../extractors/clienteHttpOcr.ts";
import { ExtractorDirecto, ExtractorDoclingOcr, RegistroExtractores } from "../../extractors/index.ts";
import { ProcesadorLotes } from "../../queue/procesadorLotes.ts";

const ocrCliente = new ClienteHttpExtraccionDocumental({
  url: "http://127.0.0.1:8000/extraer",
  timeoutMs: 15000,
});

const procesador = new ProcesadorLotes(
  new RegistroExtractores([new ExtractorDirecto(), new ExtractorDoclingOcr(ocrCliente)])
);
```
