"""Tests del PAD pasivo (anti-spoofing) — la geometría del crop + el softmax + el índice de clase.

Cubre la parte de RIESGO DE PRECISIÓN: el preprocessing (crop expandido a escala, réplica del CropImage
canónico) y el mapeo softmax→índice→veredicto (el índice DIVERGE entre exports; un índice mal puesto invierte
el veredicto — se testea explícitamente). La inferencia ONNX se mockea con una session fake (no necesita el
modelo real); cv2 (resize) sí corre (está en el .venv). La calibración del modelo REAL con muestras real/spoof
es un gate de prod aparte (ver config: spoof_live_index / spoof_threshold).
"""
from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings
from app.face.detector import FaceDetection
from app.face.spoof import AntiSpoofClassifier, SpoofVerdict, _expanded_box, _softmax


def _settings(**over: object) -> Settings:
    return Settings(**over)  # type: ignore[arg-type]


# ---------------------------------------------------------------- _softmax (pura)
def test_softmax_sums_to_one_and_argmax():
    out = _softmax(np.array([2.0, 1.0, 0.1], dtype=np.float32))
    assert float(out.sum()) == pytest.approx(1.0, abs=1e-5)
    assert int(np.argmax(out)) == 0


def test_softmax_stable_with_large_logits():
    out = _softmax(np.array([1000.0, 999.0, 998.0], dtype=np.float32))
    assert np.isfinite(out).all()
    assert float(out.sum()) == pytest.approx(1.0, abs=1e-5)


# ---------------------------------------------------------------- _expanded_box (geometría exacta)
def test_expanded_box_centered_within_bounds():
    # bbox [left,top,w,h]=[40,40,20,20], img 200x200, scale 2.0 → caja 40x40 centrada en (50,50) → [30,30]..[70,70].
    assert _expanded_box(200, 200, (40.0, 40.0, 20.0, 20.0), 2.0) == (30, 30, 70, 70)


def test_expanded_box_clamps_scale_to_image():
    # scale enorme se clampa a (src-1)/box (1.99) → la caja no excede la imagen.
    x1, y1, x2, y2 = _expanded_box(200, 200, (50.0, 50.0, 100.0, 100.0), 99.0)
    assert x1 >= 0 and y1 >= 0 and x2 <= 199 and y2 <= 199


def test_expanded_box_shifts_off_border_preserving_size():
    # bbox pegado al borde izquierdo → la caja se DESPLAZA (no recorta) para conservar el tamaño (40).
    x1, y1, x2, y2 = _expanded_box(200, 200, (0.0, 80.0, 20.0, 20.0), 2.0)
    assert x1 == 0
    assert (x2 - x1) == 40


# ---------------------------------------------------------------- classify (session FAKE + cv2 real)
class _FakeSession:
    def __init__(self, output: object) -> None:
        self._output = output

    def get_inputs(self):  # noqa: ANN201
        class _I:
            name = "input"
            shape = [1, 3, 80, 80]

        return [_I()]

    def get_outputs(self):  # noqa: ANN201
        class _O:
            name = "output"

        return [_O()]

    def run(self, names, feed):  # noqa: ANN001, ANN201, ARG002
        return [np.asarray(self._output, dtype=np.float32)]


def _classifier(output: object, settings: Settings) -> AntiSpoofClassifier:
    """Construye el clasificador SALTEANDO __init__ (que carga onnxruntime): inyecta una session fake."""
    clf = object.__new__(AntiSpoofClassifier)
    clf._settings = settings  # type: ignore[attr-defined]
    clf._session = _FakeSession(output)  # type: ignore[attr-defined]
    clf._input_name = "input"  # type: ignore[attr-defined]
    clf._output_name = "output"  # type: ignore[attr-defined]
    clf._h = 80  # type: ignore[attr-defined]
    clf._w = 80  # type: ignore[attr-defined]
    return clf


def _detection() -> FaceDetection:
    return FaceDetection(
        bbox=np.array([40, 40, 60, 60], dtype=np.float32),
        keypoints=np.zeros((5, 2), dtype=np.float32),
        score=0.99,
    )


def _image() -> np.ndarray:
    return np.full((200, 200, 3), 128, dtype=np.uint8)


def test_classify_live_when_score_above_threshold():
    # live_index=0, umbral 0.6. logits [3,0,0] → softmax[0] ~0.9 → live.
    verdict = _classifier([[3.0, 0.0, 0.0]], _settings(spoof_live_index=0, spoof_threshold=0.6)).classify(
        _image(), _detection()
    )
    assert isinstance(verdict, SpoofVerdict)
    assert verdict.live is True and verdict.score > 0.6


def test_classify_spoof_when_score_below_threshold():
    # logits [0,3,0] → softmax[0] ~0.04 → spoof.
    verdict = _classifier([[0.0, 3.0, 0.0]], _settings(spoof_live_index=0, spoof_threshold=0.6)).classify(
        _image(), _detection()
    )
    assert verdict.live is False and verdict.score < 0.6


def test_classify_index_inversion_flips_verdict():
    # MISMO output, distinto índice de clase viva → veredicto INVERSO. Prueba por qué el índice es crítico.
    out = [[3.0, 0.0, 0.0]]  # clase 0 dominante
    assert _classifier(out, _settings(spoof_live_index=0)).classify(_image(), _detection()).live is True
    assert _classifier(out, _settings(spoof_live_index=1)).classify(_image(), _detection()).live is False


def test_classify_fail_closed_on_index_out_of_range():
    # índice fuera de rango (config errónea vs 3 clases) → fail-closed (spoof, score 0).
    verdict = _classifier([[3.0, 0.0, 0.0]], _settings(spoof_live_index=9)).classify(_image(), _detection())
    assert verdict.live is False and verdict.score == 0.0
