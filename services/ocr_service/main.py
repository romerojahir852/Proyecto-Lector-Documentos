from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from ocr_engine import DocumentoEntradaOcr, acotar_confianza, crear_motor_ocr

STORAGE_BASE_DIR = Path(os.getenv("OCR_STORAGE_DIR", "./storage")).resolve()

app = FastAPI(
    title="Servicio OCR Documental",
    version="0.1.0",
    description="Microservicio desacoplado de extracción documental (Docling / PaddleOCR) compatible con ClienteHttpExtraccionDocumental.",
)

motor_ocr = crear_motor_ocr()


class SolicitudExtraccionJson(BaseModel):
    archivoId: str = Field(..., min_length=1)
    tenantId: str = Field(..., min_length=1)
    loteId: str = Field(..., min_length=1)
    nombreOriginal: str = Field(..., min_length=1)
    mimeType: str = Field(..., min_length=1)
    tamanoBytes: int = Field(..., gt=0)
    rutaStorage: str = Field(default="")
    hashSha256: str = Field(default="")
    contenidoBase64: str | None = None


def _resolver_ruta_segura(ruta_storage: str) -> Path | None:
    if not ruta_storage:
        return None
    candidata = (STORAGE_BASE_DIR / ruta_storage).resolve()
    if not candidata.is_relative_to(STORAGE_BASE_DIR):
        raise HTTPException(status_code=400, detail="rutaStorage fuera del directorio permitido.")
    if candidata.is_file():
        return candidata
    return None


def extraer_con_motor_documental(doc: DocumentoEntradaOcr) -> list[dict[str, Any]]:
    """
    Gancho de integración para Docling o PaddleOCR.
    Delega en el adaptador activo (`motor_ocr`) y cae de forma segura al modo base
    cuando los motores pesados no están instalados en la máquina local.
    """
    return motor_ocr.extraer(doc)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "motor": motor_ocr.nombre}


@app.post("/extraer")
async def extraer(request: Request) -> dict[str, Any]:
    content_type = (request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in content_type:
        form = await request.form()
        archivo = form.get("file")
        tenant_id = str(form.get("tenantId") or "").strip()
        if not tenant_id:
            raise HTTPException(status_code=400, detail="tenantId es obligatorio.")
        if archivo is None or not hasattr(archivo, "read"):
            raise HTTPException(status_code=400, detail="Debe adjuntar el campo 'file'.")

        contenido_bytes = await archivo.read()
        if not contenido_bytes:
            raise HTTPException(status_code=400, detail="El archivo enviado está vacío.")

        doc = DocumentoEntradaOcr(
            tenant_id=tenant_id,
            archivo_id=str(form.get("archivoId") or "upload-local"),
            nombre_original=getattr(archivo, "filename", None) or "documento.bin",
            mime_type=getattr(archivo, "content_type", None) or "application/octet-stream",
            ruta_storage="",
            contenido_bytes=contenido_bytes,
        )
    else:
        try:
            raw_body = await request.json()
            solicitud = SolicitudExtraccionJson.model_validate(raw_body)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Cuerpo JSON inválido.") from exc

        if not solicitud.tenantId.strip():
            raise HTTPException(status_code=400, detail="tenantId es obligatorio.")

        contenido_bytes: bytes | None = None
        if solicitud.contenidoBase64 is not None:
            try:
                contenido_bytes = base64.b64decode(solicitud.contenidoBase64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise HTTPException(status_code=400, detail="contenidoBase64 inválido.") from exc
            if len(contenido_bytes) == 0:
                raise HTTPException(status_code=400, detail="contenidoBase64 está vacío.")
        else:
            ruta_local = _resolver_ruta_segura(solicitud.rutaStorage)
            if ruta_local is not None:
                contenido_bytes = ruta_local.read_bytes()
                if len(contenido_bytes) == 0:
                    raise HTTPException(status_code=400, detail="El archivo en rutaStorage está vacío.")

        doc = DocumentoEntradaOcr(
            tenant_id=solicitud.tenantId.strip(),
            archivo_id=solicitud.archivoId,
            nombre_original=solicitud.nombreOriginal,
            mime_type=solicitud.mimeType,
            ruta_storage=solicitud.rutaStorage,
            contenido_bytes=contenido_bytes,
        )

    try:
        candidatos_raw = extraer_con_motor_documental(doc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error interno en extracción OCR: {exc}") from exc

    candidatos = [
        {
            "tipoDocumento": c.get("tipoDocumento", "otro"),
            "fechaDocumento": c.get("fechaDocumento"),
            "monto": c.get("monto"),
            "identificacion": c.get("identificacion"),
            "nombreTercero": c.get("nombreTercero"),
            "referencia": c.get("referencia"),
            "confianza": acotar_confianza(c.get("confianza", 0.0)),
            "datosCrudos": c.get("datosCrudos") if isinstance(c.get("datosCrudos"), dict) else {},
        }
        for c in candidatos_raw
    ]

    return {"candidatos": candidatos}


if __name__ == "__main__":
    import uvicorn

    puerto = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="127.0.0.1", port=puerto, reload=False)
