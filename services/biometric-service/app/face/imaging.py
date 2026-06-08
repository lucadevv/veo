"""Decodificación de imágenes (bytes / base64) a ndarray BGR para el pipeline."""
from __future__ import annotations

import base64
import binascii

import numpy as np
import numpy.typing as npt

NDArrayU8 = npt.NDArray[np.uint8]


def decode_image_bytes(data: bytes) -> NDArrayU8:
    """Decodifica bytes de una imagen (JPEG/PNG/...) a ndarray BGR (OpenCV)."""
    import cv2  # carga perezosa

    if not data:
        raise ValueError("Imagen vacía")
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
