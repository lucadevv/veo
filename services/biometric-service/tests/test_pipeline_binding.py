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


def _pipeline() -> BiometricPipeline:
    return BiometricPipeline(Settings(internal_identity_secret="x", require_auth=False))


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
