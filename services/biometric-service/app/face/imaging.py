"""Decodificación de imágenes (bytes / base64) a ndarray BGR para el pipeline."""
from __future__ import annotations

import base64
import binascii

import numpy as np
import numpy.typing as npt

NDArrayU8 = npt.NDArray[np.uint8]


def _exif_oriented_bgr(data: bytes) -> NDArrayU8 | None:
    """Decodifica con Pillow aplicando la orientación EXIF y devuelve BGR; None si no aplica.

    El cliente Android suele mandar el JPEG SIN rotar los píxeles, dejando la rotación
    declarada en el tag EXIF Orientation. `cv2.imdecode` IGNORA ese tag, así que la cara
    entraría rotada al detector SCRFD / embedder ArcFace, degradando detección y embedding.
    `ImageOps.exif_transpose` aplica la transposición/rotación del tag y lo limpia.

    Devuelve None cuando NO hay nada que corregir (sin EXIF, orientación normal, o formato
    sin metadata) → el caller cae al decode OpenCV de siempre, comportamiento idéntico al previo.
    Ante cualquier error (EXIF corrupto, Pillow no puede abrir) degrada a None SIN crashear:
    el camino OpenCV decide luego si la imagen es válida o no.
    """
    try:
        import io

        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as img:
            orientation = img.getexif().get(0x0112)  # 0x0112 = EXIF Orientation
            # 1 = normal; None/ausente = sin metadata. En ambos casos no hay rotación que aplicar
            # y dejamos que OpenCV decodifique igual que siempre (default seguro).
            if orientation in (None, 1):
                return None
            transposed = ImageOps.exif_transpose(img)
            if transposed is None:
                return None
            rgb = np.asarray(transposed.convert("RGB"), dtype=np.uint8)
    except Exception:  # noqa: BLE001 — EXIF corrupto / formato raro: degradar, nunca romper el embed
        return None

    import cv2  # carga perezosa

    # El pipeline trabaja en BGR (OpenCV). Pillow entrega RGB → convertimos para no alterar
    # el espacio de color que esperan el detector y el embedder.
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    return np.asarray(bgr, dtype=np.uint8)


def decode_image_bytes(data: bytes) -> NDArrayU8:
    """Decodifica bytes de una imagen (JPEG/PNG/...) a ndarray BGR (OpenCV).

    Respeta el tag EXIF Orientation antes de pasar la imagen a los modelos: si el JPEG trae
    orientación en EXIF, se aplica la rotación con Pillow. Si no hay EXIF (buffer crudo, caso
    común), el resultado es idéntico al decode OpenCV de siempre.
    """
    import cv2  # carga perezosa

    if not data:
        raise ValueError("Imagen vacía")

    oriented = _exif_oriented_bgr(data)
    if oriented is not None:
        return oriented

    arr = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("No se pudo decodificar la imagen (formato no soportado)")
    return np.asarray(image, dtype=np.uint8)


def decode_base64_image(b64: str) -> NDArrayU8:
    """Decodifica una imagen en base64 (con o sin prefijo data URI) a BGR."""
    payload = b64.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("base64 inválido") from exc
    return decode_image_bytes(raw)
