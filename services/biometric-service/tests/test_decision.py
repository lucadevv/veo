"""Tests de la máquina de decisión PASS/FAIL/BLOCKED (dominio)."""
from __future__ import annotations

import pytest

from app.domain import DecisionInput, VerificationResult, decide

THRESHOLD = 0.90


def _inp(**kw: object) -> DecisionInput:
    base = dict(
        challenge_valid=True,
        faces_detected=1,
        liveness_passed=True,
        match_score=0.95,
        match_threshold=THRESHOLD,
    )
    base.update(kw)
    return DecisionInput(**base)  # type: ignore[arg-type]


def test_pass_when_all_ok() -> None:
    d = decide(_inp())
    assert d.result is VerificationResult.PASS
    assert d.liveness_passed is True
    assert d.match_passed is True


def test_fail_when_score_below_threshold() -> None:
    d = decide(_inp(match_score=0.89))
    assert d.result is VerificationResult.FAIL
    assert d.match_passed is False
    assert d.liveness_passed is True


def test_pass_at_exact_threshold() -> None:
    d = decide(_inp(match_score=0.90))
    assert d.result is VerificationResult.PASS
    assert d.match_passed is True


def test_fail_when_liveness_failed() -> None:
    d = decide(_inp(liveness_passed=False))
    assert d.result is VerificationResult.FAIL
    assert d.liveness_passed is False
    # match podría pasar, pero sin liveness el veredicto es FAIL.
    assert d.match_passed is True


def test_fail_when_no_face() -> None:
    d = decide(_inp(faces_detected=0))
    assert d.result is VerificationResult.FAIL
    assert "rostro" in d.reason.lower()


def test_fail_when_multiple_faces() -> None:
    d = decide(_inp(faces_detected=2))
    assert d.result is VerificationResult.FAIL


def test_blocked_when_challenge_invalid() -> None:
    d = decide(_inp(challenge_valid=False))
    assert d.result is VerificationResult.BLOCKED


def test_blocked_takes_priority_over_match() -> None:
    # Aunque el match fuese perfecto, un reto inválido → BLOCKED (sesión no confiable).
    d = decide(_inp(challenge_valid=False, match_score=1.0))
    assert d.result is VerificationResult.BLOCKED


@pytest.mark.parametrize(
    "score,liveness,faces,challenge_valid,expected",
    [
        (0.99, True, 1, True, VerificationResult.PASS),
        (0.90, True, 1, True, VerificationResult.PASS),
        (0.89, True, 1, True, VerificationResult.FAIL),
        (0.99, False, 1, True, VerificationResult.FAIL),
        (0.99, True, 0, True, VerificationResult.FAIL),
        (0.99, True, 1, False, VerificationResult.BLOCKED),
    ],
)
def test_decision_matrix(
    score: float,
    liveness: bool,
    faces: int,
    challenge_valid: bool,
    expected: VerificationResult,
) -> None:
    d = decide(
        DecisionInput(
            challenge_valid=challenge_valid,
            faces_detected=faces,
            liveness_passed=liveness,
            match_score=score,
            match_threshold=THRESHOLD,
        )
    )
    assert d.result is expected
