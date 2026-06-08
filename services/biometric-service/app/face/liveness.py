"""Liveness ACTIVO por reto (challenge-response).

El servidor emite un reto aleatorio ("gira la cabeza a la izquierda", "parpadea",
"sonríe"...). El cliente envía una secuencia de frames; el detector facial extrae
de cada frame señales geométricas (pose de cabeza, apertura de ojos/boca derivadas
de landmarks). Aquí se evalúa, con matemática REAL sobre esas señales, si la
secuencia satisface el reto. Esto vence ataques de foto estática (sin movimiento
no se supera ningún reto) y es testeable con señales controladas (sin ONNX).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence


class ChallengeAction(str, Enum):
    """Retos de liveness soportados (acción que el usuario debe realizar)."""

    TURN_LEFT = "TURN_LEFT"
    TURN_RIGHT = "TURN_RIGHT"
    NOD = "NOD"
    BLINK = "BLINK"
    SMILE = "SMILE"
    OPEN_MOUTH = "OPEN_MOUTH"


# Instrucciones legibles (es-PE) por reto, para el cliente.
CHALLENGE_INSTRUCTIONS: dict[ChallengeAction, str] = {
    ChallengeAction.TURN_LEFT: "Gira lentamente la cabeza hacia tu izquierda",
    ChallengeAction.TURN_RIGHT: "Gira lentamente la cabeza hacia tu derecha",
    ChallengeAction.NOD: "Asiente con la cabeza (mira hacia abajo y vuelve)",
    ChallengeAction.BLINK: "Parpadea dos veces mirando a la cámara",
    ChallengeAction.SMILE: "Sonríe ampliamente",
    ChallengeAction.OPEN_MOUTH: "Abre la boca",
}

# NaN sentinel: señal no disponible para este frame (p. ej. EAR sin landmarks densos).
NAN: float = float("nan")


@dataclass(frozen=True)
class FrameSignals:
    """Señales geométricas extraídas de UN frame por el detector facial.

    Convenciones:
      - yaw_deg: giro horizontal de la cabeza. Negativo = izquierda, positivo = derecha.
      - pitch_deg: cabeceo vertical. Positivo = mirar abajo.
      - eye_aspect_ratio (EAR): apertura de ojos (>0). Más bajo = más cerrado. NaN si no disponible.
      - smile_ratio: ancho de boca / distancia interocular. Más alto = sonrisa más amplia.
      - mouth_open_ratio: apertura vertical de boca / distancia interocular.
      - face_count: nº de rostros detectados en el frame.
      - detection_confidence: confianza del detector [0,1] para el rostro principal.
    """

    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    eye_aspect_ratio: float = NAN
    smile_ratio: float = 0.0
    mouth_open_ratio: float = 0.0
    face_count: int = 1
    detection_confidence: float = 1.0


@dataclass(frozen=True)
class LivenessThresholds:
    """Umbrales de decisión para cada tipo de reto."""

    min_frames: int = 3
    yaw_turn_degrees: float = 18.0
    pitch_nod_degrees: float = 12.0
    blink_ear_threshold: float = 0.21
    eye_open_ear_threshold: float = 0.28
    smile_ratio_threshold: float = 1.45
    mouth_open_ratio_threshold: float = 0.35


@dataclass(frozen=True)
class LivenessResult:
    """Veredicto de liveness con detalle para auditoría/debug."""

    passed: bool
    action: ChallengeAction
    reason: str
    detail: dict[str, float] = field(default_factory=dict)


def _valid_frames(frames: Sequence[FrameSignals]) -> list[FrameSignals]:
    """Frames con exactamente un rostro (descarta multi-rostro / sin rostro)."""
    return [f for f in frames if f.face_count == 1]


def _check_turn(
    frames: list[FrameSignals],
    action: ChallengeAction,
    th: LivenessThresholds,
) -> LivenessResult:
    yaws = [f.yaw_deg for f in frames]
    started_frontal = abs(yaws[0]) < th.yaw_turn_degrees
    if action is ChallengeAction.TURN_LEFT:
        extreme = min(yaws)  # izquierda = negativo
        reached = extreme <= -th.yaw_turn_degrees
    else:
        extreme = max(yaws)  # derecha = positivo
        reached = extreme >= th.yaw_turn_degrees
    passed = bool(started_frontal and reached)
    return LivenessResult(
        passed=passed,
        action=action,
        reason="ok" if passed else "giro insuficiente o no inicia frontal",
        detail={"start_yaw": yaws[0], "extreme_yaw": extreme},
    )


def _check_nod(frames: list[FrameSignals], th: LivenessThresholds) -> LivenessResult:
    pitches = [f.pitch_deg for f in frames]
    delta = max(pitches) - min(pitches)
    passed = delta >= th.pitch_nod_degrees
    return LivenessResult(
        passed=bool(passed),
        action=ChallengeAction.NOD,
        reason="ok" if passed else "cabeceo insuficiente",
        detail={"pitch_delta": delta},
    )


def _check_blink(frames: list[FrameSignals], th: LivenessThresholds) -> LivenessResult:
    ears = [f.eye_aspect_ratio for f in frames if not math.isnan(f.eye_aspect_ratio)]
    if len(ears) < th.min_frames:
        return LivenessResult(
            passed=False,
            action=ChallengeAction.BLINK,
            reason="EAR no disponible (se requiere modelo de landmarks densos)",
            detail={"ear_samples": float(len(ears))},
        )
    closed = min(ears)
    opened = max(ears)
    # Un parpadeo real: ojos llegan a cerrarse (EAR bajo) y vuelven a abrirse (EAR alto).
    passed = closed <= th.blink_ear_threshold and opened >= th.eye_open_ear_threshold
    return LivenessResult(
        passed=bool(passed),
        action=ChallengeAction.BLINK,
        reason="ok" if passed else "no se detectó cierre+apertura de ojos",
        detail={"min_ear": closed, "max_ear": opened},
    )


def _check_smile(frames: list[FrameSignals], th: LivenessThresholds) -> LivenessResult:
    ratios = [f.smile_ratio for f in frames]
    baseline = ratios[0]
    peak = max(ratios)
    # Sonrisa: el ancho de boca supera el umbral Y crece respecto al baseline neutro.
    passed = peak >= th.smile_ratio_threshold and peak > baseline
    return LivenessResult(
        passed=bool(passed),
        action=ChallengeAction.SMILE,
        reason="ok" if passed else "sonrisa insuficiente",
        detail={"baseline_ratio": baseline, "peak_ratio": peak},
    )


def _check_open_mouth(frames: list[FrameSignals], th: LivenessThresholds) -> LivenessResult:
    ratios = [f.mouth_open_ratio for f in frames]
    peak = max(ratios)
    passed = peak >= th.mouth_open_ratio_threshold and peak > ratios[0]
    return LivenessResult(
        passed=bool(passed),
        action=ChallengeAction.OPEN_MOUTH,
        reason="ok" if passed else "apertura de boca insuficiente",
        detail={"baseline_ratio": ratios[0], "peak_ratio": peak},
    )


def evaluate_liveness(
    action: ChallengeAction,
    frames: Sequence[FrameSignals],
    thresholds: LivenessThresholds,
) -> LivenessResult:
    """Evalúa si la secuencia de frames satisface el reto `action`.

    Reglas de seguridad comunes a todos los retos:
      - Se requieren al menos `min_frames` frames con UN solo rostro.
      - Sin variación (foto estática) ningún reto de movimiento se supera.
    """
    valid = _valid_frames(list(frames))
    if len(valid) < thresholds.min_frames:
        return LivenessResult(
            passed=False,
            action=action,
            reason="frames insuficientes con un rostro único",
            detail={"valid_frames": float(len(valid))},
        )

    if action in (ChallengeAction.TURN_LEFT, ChallengeAction.TURN_RIGHT):
        return _check_turn(valid, action, thresholds)
    if action is ChallengeAction.NOD:
        return _check_nod(valid, thresholds)
    if action is ChallengeAction.BLINK:
        return _check_blink(valid, thresholds)
    if action is ChallengeAction.SMILE:
        return _check_smile(valid, thresholds)
    if action is ChallengeAction.OPEN_MOUTH:
        return _check_open_mouth(valid, thresholds)
    # enum exhaustivo: inalcanzable, pero explícito para mypy.
    raise ValueError(f"Reto no soportado: {action}")
