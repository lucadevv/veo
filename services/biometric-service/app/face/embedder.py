"""Extractor de embeddings ArcFace (ONNX) — embeddings faciales REALES de 512-d.

Alinea el rostro a la plantilla canónica de ArcFace (112x112) usando los 5
keypoints del detector y una transformación de similitud, normaliza e infiere el
embedding con onnxruntime. Imports pesados perezosos (ver detector.py).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import numpy.typing as npt

from app.config import Settings
from app.face.detector import FaceDetection
from app.face.matcher import l2_normalize

if TYPE_CHECKING:
    import onnxruntime as ort

NDArrayF = npt.NDArray[np.float32]

# Plantilla canónica de 5 puntos de ArcFace para crop de 112x112 (InsightFace).
ARCFACE_TEMPLATE: NDArrayF = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)
ALIGNED_SIZE = 112


def align_face(image_bgr: "np.ndarray", keypoints: NDArrayF) -> "np.ndarray":  # type: ignore[type-arg]
    """Recorta y alinea el rostro a 112x112 usando los 5 keypoints (similarity transform)."""
    import cv2  # carga perezosa

    matrix, _ = cv2.estimateAffinePartial2D(
        keypoints.astype(np.float32), ARCFACE_TEMPLATE, method=cv2.LMEDS
    )
    if matrix is None:
        raise ValueError("No se pudo estimar la transformación de alineación facial")
    aligned = cv2.warpAffine(
        image_bgr,
        matrix,
        (ALIGNED_SIZE, ALIGNED_SIZE),
        borderValue=(0.0, 0.0, 0.0),
    )
    return np.asarray(aligned, dtype=np.uint8)


class ArcFaceEmbedder:
    """Wrapper ONNX de un recognizer ArcFace (salida 512-d, p. ej. w600k_r50)."""

    def __init__(self, model_path: str, settings: Settings) -> None:
        import onnxruntime as ort  # carga perezosa

        self._settings = settings
        self._session: ort.InferenceSession = ort.InferenceSession(
            model_path, providers=list(settings.onnx_providers)
        )
        self._input_name = self._session.get_inputs()[0].name
        output = self._session.get_outputs()[0]
        self._output_name = output.name
        self._dim = int(output.shape[-1]) if output.shape and output.shape[-1] else 512

    @property
    def dim(self) -> int:
        return self._dim

    def _preprocess(self, aligned_bgr: "np.ndarray") -> NDArrayF:  # type: ignore[type-arg]
        import cv2  # carga perezosa

        rgb = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2RGB)
        # Normalización ArcFace estándar: (x - 127.5) / 127.5 → [-1, 1].
        blob = (rgb.astype(np.float32) - 127.5) / 127.5
        # HWC → NCHW.
        blob = np.transpose(blob, (2, 0, 1))[np.newaxis, ...]
        return blob.astype(np.float32)

    def embed_aligned(self, aligned_bgr: "np.ndarray") -> NDArrayF:  # type: ignore[type-arg]
        """Embedding L2-normalizado a partir de un crop alineado 112x112."""
        blob = self._preprocess(aligned_bgr)
        out = self._session.run([self._output_name], {self._input_name: blob})[0]
        vector = np.asarray(out, dtype=np.float32).reshape(-1)
        return l2_normalize(vector)

    def embed_face(
        self, image_bgr: "np.ndarray", detection: FaceDetection  # type: ignore[type-arg]
    ) -> NDArrayF:
        """Pipeline completo: alinea con keypoints y devuelve el embedding normalizado."""
        aligned = align_face(image_bgr, detection.keypoints)
        return self.embed_aligned(aligned)


def load_embedder(settings: Settings, model_path: str) -> ArcFaceEmbedder:
    """Crea el embedder ArcFace desde un fichero ONNX existente."""
    return ArcFaceEmbedder(model_path, settings)


__all__ = [
    "ArcFaceEmbedder",
    "ARCFACE_TEMPLATE",
    "align_face",
    "load_embedder",
]
