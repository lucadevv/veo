"""Tests del binding anti-spoofing en pipeline.verify: el match se ata a la identidad que hizo el
gesto. Si se intercala otra persona (splicing), la consistencia intra-secuencia falla → FAIL.

Se monkeypatchean extract_signals/evaluate_liveness/best_detection/embed para controlar las
identidades por frame sin modelos ONNX (la matemática de coseno es real)."""
from __future__ import annotations

from typing import List

import numpy as np
import pytest

from app.config import Settings
from app.domain import VerificationResult
from app.face.liveness import ChallengeAction, FrameSignals, LivenessResult
from app.face.pipeline import BiometricPipeline
from app.face.spoof import SpoofVerdict


def _pipeline() -> BiometricPipeline:
    # Modo ACTIVO: estos tests ejercen el MATCH/binding (consistencia intra-secuencia), que es idéntico en
    # ambos modos de liveness. Mockean `evaluate_liveness` (activo) para aislar el binding del PAD pasivo.
    return BiometricPipeline(
        Settings(internal_identity_secret="x", require_auth=False, verify_liveness_mode="active")
    )


def _unit_vec(seed: int) -> np.ndarray:
    v = np.random.default_rng(seed).standard_normal(512).astype(np.float32)
    return (v / np.linalg.norm(v)).astype(np.float32)


def _wire(
    monkeypatch: pytest.MonkeyPatch,
    pipeline: BiometricPipeline,
    embeddings: List[np.ndarray],
) -> None:
    n = len(embeddings)
    monkeypatch.setattr(pipeline, "extract_signals", lambda _frames: [FrameSignals(face_count=1) for _ in range(n)])
    monkeypatch.setattr(
        "app.face.pipeline.evaluate_liveness",
        lambda action, _signals, _th: LivenessResult(passed=True, action=action, reason="ok"),
    )
    monkeypatch.setattr(pipeline, "best_detection", lambda _frame: (1, object()))
    it = iter(embeddings)
    monkeypatch.setattr(pipeline, "embed", lambda _frame, _det: next(it))


def test_misma_identidad_en_todos_los_frames_pasa(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = _pipeline()
    same = _unit_vec(1)
    _wire(monkeypatch, pipeline, [same, same, same])
    out = pipeline.verify(
        action=ChallengeAction.TURN_LEFT,
        challenge_valid=True,
        frames_bgr=[object(), object(), object()],
        reference_embedding=same.tolist(),  # self-match → score 1.0 ≥ 0.90
    )
    assert out.decision.result is VerificationResult.PASS


def test_identidad_intercalada_es_rechazada(monkeypatch: pytest.MonkeyPatch) -> None:
    # El atacante hace el gesto con SU cara en el anchor, pero un frame es de otra persona (o al revés):
    # la consistencia intra-secuencia cae < umbral → FAIL aunque el match contra la referencia diera bien.
    pipeline = _pipeline()
    victim = _unit_vec(1)
    attacker = _unit_vec(99)  # casi ortogonal a victim en 512-d
    _wire(monkeypatch, pipeline, [victim, attacker, victim])
    out = pipeline.verify(
        action=ChallengeAction.TURN_LEFT,
        challenge_valid=True,
        frames_bgr=[object(), object(), object()],
        reference_embedding=victim.tolist(),
    )
    assert out.decision.result is VerificationResult.FAIL
    assert "inconsistente" in out.decision.reason.lower()


def test_sin_frames_validos_no_rompe(monkeypatch: pytest.MonkeyPatch) -> None:
    # 0 frames con rostro → no hay embeddings → faces_count=0 → FAIL "no se detectó rostro", sin crash.
    pipeline = _pipeline()
    monkeypatch.setattr(pipeline, "extract_signals", lambda _frames: [FrameSignals(face_count=0)])
    monkeypatch.setattr(
        "app.face.pipeline.evaluate_liveness",
        lambda action, _signals, _th: LivenessResult(passed=False, action=action, reason="sin rostro"),
    )
    out = pipeline.verify(
        action=ChallengeAction.TURN_LEFT,
        challenge_valid=True,
        frames_bgr=[object()],
        reference_embedding=_unit_vec(1).tolist(),
    )
    assert out.decision.result is VerificationResult.FAIL


def _pipeline_passive() -> BiometricPipeline:
    return BiometricPipeline(
        Settings(internal_identity_secret="x", require_auth=False, verify_liveness_mode="passive")
    )


def _wire_passive(
    monkeypatch: pytest.MonkeyPatch,
    pipeline: BiometricPipeline,
    embeddings: List[np.ndarray],
    *,
    live: bool,
) -> None:
    """Cablea el pipeline en modo PASIVO: PAD (`classify_liveness`) controlado + `_frame_quality` mockeado
    (evita cv2 sobre frames sintéticos) + embeddings deterministas para el match."""
    n = len(embeddings)
    monkeypatch.setattr(pipeline, "extract_signals", lambda _f: [FrameSignals(face_count=1) for _ in range(n)])
    monkeypatch.setattr(pipeline, "best_detection", lambda _f: (1, object()))
    monkeypatch.setattr(pipeline, "_frame_quality", lambda _f, _s: 1.0)
    monkeypatch.setattr(
        pipeline, "classify_liveness", lambda _img, _det: SpoofVerdict(live=live, score=0.9 if live else 0.1)
    )
    it = iter(embeddings)
    monkeypatch.setattr(pipeline, "embed", lambda _f, _d: next(it))


def test_verify_pasivo_pad_vivo_y_match_pasa(monkeypatch: pytest.MonkeyPatch) -> None:
    # Turno PASIVO (decisión del dueño): el PAD dice vivo + el match contra la referencia pasa → PASS,
    # SIN reto de acción. El conductor no ejecuta un gesto guiado.
    pipeline = _pipeline_passive()
    same = _unit_vec(1)
    _wire_passive(monkeypatch, pipeline, [same, same], live=True)
    out = pipeline.verify(
        action=ChallengeAction.SMILE,
        challenge_valid=True,
        frames_bgr=[object(), object()],
        reference_embedding=same.tolist(),
    )
    assert out.decision.result is VerificationResult.PASS
    assert out.liveness.passed


def test_verify_pasivo_pad_spoof_rechaza(monkeypatch: pytest.MonkeyPatch) -> None:
    # Turno PASIVO: el PAD detecta suplantación (foto/pantalla) → FAIL aunque el match diera bien.
    pipeline = _pipeline_passive()
    same = _unit_vec(1)
    _wire_passive(monkeypatch, pipeline, [same, same], live=False)
    out = pipeline.verify(
        action=ChallengeAction.SMILE,
        challenge_valid=True,
        frames_bgr=[object(), object()],
        reference_embedding=same.tolist(),
    )
    assert out.decision.result is VerificationResult.FAIL
    assert not out.liveness.passed
