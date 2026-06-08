"""Dominio: máquina de decisión de la verificación biométrica.

Combina las tres señales reales del pipeline en un veredicto:
  - validez del reto (challenge presente y no vencido),
  - detección facial (exactamente UN rostro claro),
  - liveness activo (la secuencia satisface el reto),
  - match (similitud coseno >= umbral, BR-I02).

Resultados:
  - PASS    : liveness OK y match OK con un único rostro y reto válido.
  - FAIL    : reto válido pero no se superó liveness y/o match (incluye 0/≠1 rostros).
  - BLOCKED : el reto es inválido/vencido/desconocido → la sesión no es confiable
              (posible replay o expiración). identity-service contabiliza el intento.

Nota de contrato (BR-I02): identity-service gestiona los 3 intentos y el bloqueo de
1h; este servicio solo devuelve el resultado REAL de cada verificación.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class VerificationResult(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class DecisionInput:
    """Entradas a la máquina de decisión (ya calculadas por el pipeline)."""

    challenge_valid: bool
    faces_detected: int
    liveness_passed: bool
    match_score: float
    match_threshold: float


@dataclass(frozen=True)
class Decision:
    """Veredicto final + banderas derivadas para el contrato con identity-service."""

    result: VerificationResult
    score: float
    liveness_passed: bool
    match_passed: bool
    reason: str


def decide(data: DecisionInput) -> Decision:
    """Aplica las reglas de negocio y devuelve el veredicto PASS/FAIL/BLOCKED."""
    match_passed = data.match_score >= data.match_threshold

    # 1) Reto inválido/vencido → BLOCKED (sesión no confiable, no es un simple no-match).
    if not data.challenge_valid:
        return Decision(
            result=VerificationResult.BLOCKED,
            score=data.match_score,
            liveness_passed=data.liveness_passed,
            match_passed=match_passed,
            reason="Reto de liveness inválido o vencido",
        )

    # 2) Debe haber exactamente un rostro claro.
    if data.faces_detected != 1:
        return Decision(
            result=VerificationResult.FAIL,
            score=data.match_score,
            liveness_passed=False,
            match_passed=match_passed,
            reason=(
                "No se detectó un rostro"
                if data.faces_detected == 0
                else "Se detectó más de un rostro"
            ),
        )

    # 3) Liveness + match.
    if data.liveness_passed and match_passed:
        return Decision(
            result=VerificationResult.PASS,
            score=data.match_score,
            liveness_passed=True,
            match_passed=True,
            reason="Verificación exitosa",
        )

    if not data.liveness_passed:
        reason = "Liveness no superado"
    else:
        reason = f"Match por debajo del umbral ({data.match_score:.4f} < {data.match_threshold:.2f})"
    return Decision(
        result=VerificationResult.FAIL,
        score=data.match_score,
        liveness_passed=data.liveness_passed,
        match_passed=match_passed,
        reason=reason,
    )
