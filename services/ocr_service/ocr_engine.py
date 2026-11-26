from __future__ import annotations

import importlib.util
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class DocumentoEntradaOcr:
    tenant_id: str
    archivo_id: str
    nombre_original: str
    mime_type: str
    ruta_storage: str
    contenido_bytes: bytes | None = None


def acotar_confianza(valor: Any) -> float:
    try:
        num = float(valor)
    except (TypeError, ValueError):
        return 0.0
    if num != num or num in (float("inf"), float("-inf")):
        return 0.0
    return max(0.0, min(1.0, num))


class MotorOcrBase(Protocol):
    nombre: str
    disponible: bool

    def extraer(self, doc: DocumentoEntradaOcr) -> list[dict[str, Any]]:
        ...


class AdaptadorDocling:
    """Punto de integración aislado para Docling (IBM Document Understanding)."""

    nombre = "docling"

    def __init__(self) -> None:
        self.disponible = importlib.util.find_spec("docling") is not None

    def extraer(self, doc: DocumentoEntradaOcr) -> list[dict[str, Any]]:
        if not self.disponible:
            raise RuntimeError("La librería 'docling' no está instalada en este entorno.")
        if not doc.contenido_bytes:
            raise ValueError("Docling requiere los bytes del documento para procesar.")

        from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]

        sufijo = Path(doc.nombre_original).suffix or ".pdf"
        with tempfile.NamedTemporaryFile(suffix=sufijo, delete=True) as tmp:
            tmp.write(doc.contenido_bytes)
            tmp.flush()
            converter = DocumentConverter()
            resultado = converter.convert(tmp.name)
            texto = resultado.document.export_to_markdown()

        return [
            _extraer_campos_desde_texto(
                texto=texto,
                origen="docling",
                confianza_base=0.90,
                extra={"longitud_markdown": len(texto)},
            )
        ]


class AdaptadorPaddleOcr:
    """Punto de integración aislado para PaddleOCR / PaddleOCR-VL."""

    nombre = "paddleocr"

    def __init__(self) -> None:
        self.disponible = importlib.util.find_spec("paddleocr") is not None

    def extraer(self, doc: DocumentoEntradaOcr) -> list[dict[str, Any]]:
        if not self.disponible:
            raise RuntimeError("La librería 'paddleocr' no está instalada en este entorno.")
        if not doc.contenido_bytes:
            raise ValueError("PaddleOCR requiere los bytes de la imagen o PDF.")

        from paddleocr import PaddleOCR  # type: ignore[import-not-found]

        sufijo = Path(doc.nombre_original).suffix or ".png"
        with tempfile.NamedTemporaryFile(suffix=sufijo, delete=True) as tmp:
            tmp.write(doc.contenido_bytes)
            tmp.flush()
            ocr = PaddleOCR(use_angle_cls=True, lang="es")
            resultado = ocr.ocr(tmp.name, cls=True)

        lineas: list[str] = []
        confianzas: list[float] = []
        for bloque in resultado or []:
            for linea in bloque or []:
                if len(linea) >= 2 and isinstance(linea[1], (list, tuple)):
                    lineas.append(str(linea[1][0]))
                    confianzas.append(acotar_confianza(linea[1][1]))

        texto = "\n".join(lineas)
        confianza_media = sum(confianzas) / len(confianzas) if confianzas else 0.0
        return [
            _extraer_campos_desde_texto(
                texto=texto,
                origen="paddleocr",
                confianza_base=confianza_media,
                extra={"lineas_detectadas": len(lineas)},
            )
        ]


class AdaptadorFallbackLocal:
    """
    Fallback seguro cuando Docling/PaddleOCR aún no están instalados localmente.
    Devuelve confianza baja (< 0.85) si no puede extraer campos confiables para que
    el motor determinista envíe el documento a `revision_rapida`.
    """

    nombre = "base"
    disponible = True

    def extraer(self, doc: DocumentoEntradaOcr) -> list[dict[str, Any]]:
        texto_decodificado = ""
        if doc.contenido_bytes:
            try:
                texto_decodificado = doc.contenido_bytes.decode("utf-8", errors="ignore")
            except Exception:
                texto_decodificado = ""

        # Solo si el contenido contiene texto legible (ej. prueba local de texto/OCR simulado)
        if texto_decodificado and any(k in texto_decodificado.lower() for k in ("ruc", "total", "monto", "fecha")):
            return [
                _extraer_campos_desde_texto(
                    texto=texto_decodificado,
                    origen="fallback_local_texto",
                    confianza_base=0.78,
                    extra={"aviso": "Motor OCR real no instalado; extracción heurística enviada a revisión."},
                )
            ]

        return [
            {
                "tipoDocumento": "otro",
                "fechaDocumento": None,
                "monto": None,
                "identificacion": None,
                "nombreTercero": None,
                "referencia": None,
                "confianza": 0.45,
                "datosCrudos": {
                    "origen": self.nombre,
                    "archivo": doc.nombre_original,
                    "mimeType": doc.mime_type,
                    "rutaStorage": doc.ruta_storage,
                    "aviso": "Docling/PaddleOCR no instalado; clasificado para revision_rapida.",
                },
            }
        ]


def _extraer_campos_desde_texto(
    texto: str,
    origen: str,
    confianza_base: float,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    match_id = re.search(r"\b(\d{10}|\d{13})\b", texto)
    match_fecha = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", texto)
    match_monto = re.search(
        r"(?:total|monto|importe)\s*[:=]?\s*\$?\s*([0-9][0-9.,]*)",
        texto,
        flags=re.IGNORECASE,
    )
    match_ref = re.search(
        r"(?:ref(?:erencia)?|factura|comprobante|secuencial)\s*[:=#]?\s*([A-Za-z0-9\-]{3,30})",
        texto,
        flags=re.IGNORECASE,
    )

    return {
        "tipoDocumento": "factura" if "factura" in texto.lower() else "comprobante",
        "fechaDocumento": match_fecha.group(1) if match_fecha else None,
        "monto": match_monto.group(1) if match_monto else None,
        "identificacion": match_id.group(1) if match_id else None,
        "nombreTercero": None,
        "referencia": match_ref.group(1) if match_ref else None,
        "confianza": acotar_confianza(confianza_base),
        "datosCrudos": {
            "origen": origen,
            "extracto": texto[:500],
            **(extra or {}),
        },
    }


def crear_motor_ocr(preferencia: str | None = None) -> MotorOcrBase:
    """
    Selecciona el backend OCR según `OCR_BACKEND` (`auto`, `docling`, `paddleocr`, `fallback`).
    Si el motor configurado no está instalado, cae de forma segura a `AdaptadorFallbackLocal`.
    """
    seleccion = (preferencia or os.getenv("OCR_BACKEND", "auto")).strip().lower()

    docling = AdaptadorDocling()
    paddle = AdaptadorPaddleOcr()

    if seleccion == "docling" and docling.disponible:
        return docling
    if seleccion == "paddleocr" and paddle.disponible:
        return paddle
    if seleccion == "auto":
        if docling.disponible:
            return docling
        if paddle.disponible:
            return paddle

    return AdaptadorFallbackLocal()
