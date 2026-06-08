"""Tests del liveness activo por reto (señales controladas, sin ONNX)."""
from __future__ import annotations

from app.face.liveness import (
    ChallengeAction,
    FrameSignals,
    LivenessThresholds,
    evaluate_liveness,
)


def _frontal(**kw: float) -> FrameSignals:
    return FrameSignals(**kw)  # type: ignore[arg-type]


def test_turn_left_pass(thresholds: LivenessThresholds) -> None:
    frames = [
        FrameSignals(yaw_deg=2.0),
        FrameSignals(yaw_deg=-12.0),
        FrameSignals(yaw_deg=-25.0),  # supera -18°
    ]
    res = evaluate_liveness(ChallengeAction.TURN_LEFT, frames, thresholds)
    assert res.passed is True


def test_turn_left_fails_if_turns_right(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(yaw_deg=2.0), FrameSignals(yaw_deg=20.0), FrameSignals(yaw_deg=30.0)]
    res = evaluate_liveness(ChallengeAction.TURN_LEFT, frames, thresholds)
    assert res.passed is False


def test_turn_right_pass(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(yaw_deg=0.0), FrameSignals(yaw_deg=14.0), FrameSignals(yaw_deg=22.0)]
    res = evaluate_liveness(ChallengeAction.TURN_RIGHT, frames, thresholds)
    assert res.passed is True


def test_static_photo_never_passes_turn(thresholds: LivenessThresholds) -> None:
    # Foto estática: sin variación de yaw → no supera el reto (anti-spoof).
    frames = [FrameSignals(yaw_deg=0.0)] * 5
    res = evaluate_liveness(ChallengeAction.TURN_LEFT, frames, thresholds)
    assert res.passed is False


def test_insufficient_frames_fails(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(yaw_deg=-25.0)]  # menos de min_frames
    res = evaluate_liveness(ChallengeAction.TURN_LEFT, frames, thresholds)
    assert res.passed is False
    assert "insuficientes" in res.reason


def test_multiface_frames_discarded(thresholds: LivenessThresholds) -> None:
    # Frames con 2 rostros se descartan; quedan menos de min_frames válidos.
    frames = [
        FrameSignals(yaw_deg=0.0, face_count=2),
        FrameSignals(yaw_deg=-25.0, face_count=2),
        FrameSignals(yaw_deg=-30.0, face_count=2),
    ]
    res = evaluate_liveness(ChallengeAction.TURN_LEFT, frames, thresholds)
    assert res.passed is False


def test_nod_pass(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(pitch_deg=0.0), FrameSignals(pitch_deg=8.0), FrameSignals(pitch_deg=15.0)]
    res = evaluate_liveness(ChallengeAction.NOD, frames, thresholds)
    assert res.passed is True


def test_nod_fail_small_movement(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(pitch_deg=0.0), FrameSignals(pitch_deg=2.0), FrameSignals(pitch_deg=4.0)]
    res = evaluate_liveness(ChallengeAction.NOD, frames, thresholds)
    assert res.passed is False


def test_smile_pass(thresholds: LivenessThresholds) -> None:
    frames = [
        FrameSignals(smile_ratio=1.2),
        FrameSignals(smile_ratio=1.4),
        FrameSignals(smile_ratio=1.6),  # supera 1.45 y crece
    ]
    res = evaluate_liveness(ChallengeAction.SMILE, frames, thresholds)
    assert res.passed is True


def test_smile_fail_no_growth(thresholds: LivenessThresholds) -> None:
    frames = [FrameSignals(smile_ratio=1.6), FrameSignals(smile_ratio=1.6), FrameSignals(smile_ratio=1.6)]
    res = evaluate_liveness(ChallengeAction.SMILE, frames, thresholds)
    # Comienza ya "ancho" y no crece → no es un gesto activo.
    assert res.passed is False


def test_blink_pass_with_ear(thresholds: LivenessThresholds) -> None:
    frames = [
        FrameSignals(eye_aspect_ratio=0.30),
        FrameSignals(eye_aspect_ratio=0.15),  # ojo cerrado
        FrameSignals(eye_aspect_ratio=0.31),  # reabre
    ]
    res = evaluate_liveness(ChallengeAction.BLINK, frames, thresholds)
    assert res.passed is True


def test_blink_unavailable_without_ear(thresholds: LivenessThresholds) -> None:
    # Sin EAR (NaN, p. ej. detector de 5 puntos) → no se puede validar parpadeo.
    frames = [FrameSignals(), FrameSignals(), FrameSignals()]
    res = evaluate_liveness(ChallengeAction.BLINK, frames, thresholds)
    assert res.passed is False
    assert "EAR" in res.reason


def test_open_mouth_pass(thresholds: LivenessThresholds) -> None:
    frames = [
        FrameSignals(mouth_open_ratio=0.05),
        FrameSignals(mouth_open_ratio=0.20),
        FrameSignals(mouth_open_ratio=0.40),  # supera 0.35
    ]
    res = evaluate_liveness(ChallengeAction.OPEN_MOUTH, frames, thresholds)
    assert res.passed is True
