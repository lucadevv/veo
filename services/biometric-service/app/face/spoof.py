"""Clasificador de ANTI-SPOOFING facial PASIVO (PAD single-frame, ONNX).

Liveness pasivo: a partir de UNA sola imagen (sin reto activo ni multi-frame) decide si el rostro es de una
persona REAL frente a la cámara o un ataque de presentación (foto impresa / pantalla / replay). Corre en el
server sobre la misma selfie del registro → cero frames extra → cero lag (a diferencia del liveness ACTIVO por
reto, que vive en el gate de turno).

Modelo: MiniFASNetV2 (minivision-ai/Silent-Face-Anti-Spoofing, Apache-2.0). El PREPROCESSING es EXACTO y NO
inventado (sourced del código de referencia + la model card del export ONNX):
  - Crop con expansión de la bbox a `scale` (2.7) centrado, recortando contra los bordes (CropImage canónico).
  - Resize a `input_size`×`input_size` (80×80), color BGR (como entrega OpenCV), normalización `/255` (sin
    mean/std), HWC→NCHW.
  - Salida: softmax de N clases. El índice de la clase REAL/viva es CONFIGURABLE (`spoof_live_index`) porque
    DIVERGE entre exports: el `.pth` canónico usa label==1, el export ONNX de HuggingFace usa índice 0. Un
    índice mal puesto INVIERTE el veredicto → por eso es config + requiere CALIBRACIÓN con muestra real/spoof
    antes de prod (ver runbook/tests de calibración). `score` = prob de la clase viva; `live = score >= umbral`.

Imports pesados (onnxruntime, cv2) perezosos (mismo patrón que detector.py/embedder.py): la lógica pura y sus
tests no requieren esas dependencias.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
import numpy.typing as npt

from app.config import Settings
from app.face.detector import FaceDetection

if TYPE_CHECKING:  # solo para type-checkers; no se importa en runtime ligero.
    import onnxruntime as ort

NDArrayF = npt.NDArray[np.float32]


@dataclass(frozen=True)
class SpoofVerdict:
    """Veredicto del PAD pasivo. `live` ya aplica el umbral; `score` es la prob de la clase viva (0..1)."""

    live: bool
    score: float


def _softmax(logits: NDArrayF) -> NDArrayF:
    """Softmax numéricamente estable sobre un vector 1-D."""
    shifted = logits - np.max(logits)
    exp = np.exp(shifted)
    return (exp / np.sum(exp)).astype(np.float32)


def _expanded_box(
    src_w: int, src_h: int, bbox_ltwh: tuple[float, float, float, float], scale: float
) -> tuple[int, int, int, int]:
    """Caja expandida a `scale` alrededor del centro de la bbox, recortada a los bordes de la imagen.

    Réplica EXACTA de `CropImage._get_new_box` del repo canónico (Silent-Face): el `scale` se clampa para no
    exceder la imagen, y si la caja se sale de un borde se DESPLAZA (no se recorta) para conservar el tamaño.
    `bbox_ltwh` = [left, top, width, height] (no [x1,y1,x2,y2]).
    """
    x, y, box_w, box_h = bbox_ltwh
    box_w = max(box_w, 1.0)
    box_h = max(box_h, 1.0)
    scale = min((src_h - 1) / box_h, min((src_w - 1) / box_w, scale))
    new_width = box_w * scale
    new_height = box_h * scale
    center_x = box_w / 2.0 + x
    center_y = box_h / 2.0 + y

    left_top_x = center_x - new_width / 2.0
    left_top_y = center_y - new_height / 2.0
    right_bottom_x = center_x + new_width / 2.0
    right_bottom_y = center_y + new_height / 2.0

    if left_top_x < 0:
        right_bottom_x -= left_top_x
        left_top_x = 0
    if left_top_y < 0:
        right_bottom_y -= left_top_y
        left_top_y = 0
    if right_bottom_x > src_w - 1:
        left_top_x -= right_bottom_x - src_w + 1
        right_bottom_x = src_w - 1
    if right_bottom_y > src_h - 1:
        left_top_y -= right_bottom_y - src_h + 1
        right_bottom_y = src_h - 1

    return int(left_top_x), int(left_top_y), int(right_bottom_x), int(right_bottom_y)


class AntiSpoofClassifier:
    """Wrapper ONNX de un PAD MiniFASNet (entrada NCHW BGR/255 80×80, salida softmax N-clases)."""

    def __init__(self, model_path: str, settings: Settings) -> None:
        import onnxruntime as ort  # carga perezosa

        self._settings = settings
        self._session: ort.InferenceSession = ort.InferenceSession(
            model_path, providers=list(settings.onnx_providers)
        )
        self._input_name = self._session.get_inputs()[0].name
        self._output_name = self._session.get_outputs()[0].name
        # Tamaño de entrada del modelo (NCHW); cae al config si el ONNX trae dims dinámicas.
        shape = self._session.get_inputs()[0].shape
        self._h = int(shape[2]) if len(shape) >= 4 and isinstance(shape[2], int) else settings.spoof_input_size
        self._w = int(shape[3]) if len(shape) >= 4 and isinstance(shape[3], int) else settings.spoof_input_size

    def _preprocess(self, image_bgr: "np.ndarray", detection: FaceDetection) -> NDArrayF:  # type: ignore[type-arg]
        import cv2  # carga perezosa

        src_h, src_w = image_bgr.shape[:2]
        b = detection.bbox  # [x1, y1, x2, y2]
        bbox_ltwh = (float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1]))
        x1, y1, x2, y2 = _expanded_box(src_w, src_h, bbox_ltwh, self._settings.spoof_scale)
        crop = image_bgr[y1 : y2 + 1, x1 : x2 + 1]
        resized = cv2.resize(crop, (self._w, self._h))  # BGR, sin conversión de color
        # `/255` → [0,1] (SIN mean/std). HWC → NCHW.
        blob = resized.astype(np.float32) / 255.0
        blob = np.transpose(blob, (2, 0, 1))[np.newaxis, ...]
        return blob.astype(np.float32)

    def classify(self, image_bgr: "np.ndarray", detection: FaceDetection) -> SpoofVerdict:  # type: ignore[type-arg]
        """Veredicto de vida pasivo sobre el rostro `detection` de la imagen BGR."""
        blob = self._preprocess(image_bgr, detection)
        out = self._session.run([self._output_name], {self._input_name: blob})[0]
        probs = _softmax(np.asarray(out, dtype=np.float32).reshape(-1))
        index = self._settings.spoof_live_index
        # Índice fuera de rango (config errónea vs salida del modelo) → fail-closed: lo tratamos como spoof.
        if index < 0 or index >= probs.shape[0]:
            return SpoofVerdict(live=False, score=0.0)
        score = float(probs[index])
        return SpoofVerdict(live=score >= self._settings.spoof_threshold, score=score)


def load_anti_spoof(settings: Settings, model_path: str) -> AntiSpoofClassifier:
    """Crea el clasificador anti-spoofing desde un fichero ONNX existente."""
    return AntiSpoofClassifier(model_path, settings)


__all__ = [
    "AntiSpoofClassifier",
    "SpoofVerdict",
    "load_anti_spoof",
    "_expanded_box",
    "_softmax",
]
