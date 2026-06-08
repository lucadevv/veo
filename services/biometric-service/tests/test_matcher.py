"""Tests de la matemática de matching (similitud coseno + umbral 0.90, BR-I02)."""
from __future__ import annotations

import numpy as np
import pytest

from app.face.matcher import (
    cosine_similarity,
    is_match,
    l2_normalize,
    match_score,
    to_vector,
    verify_match,
)

THRESHOLD = 0.90


def test_identical_vectors_score_one() -> None:
    v = to_vector([1.0, 2.0, 3.0, 4.0])
    assert cosine_similarity(v, v) == pytest.approx(1.0)
    assert match_score(v, v) == pytest.approx(1.0)


def test_orthogonal_vectors_score_zero() -> None:
    a = to_vector([1.0, 0.0])
    b = to_vector([0.0, 1.0])
    assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-6)
    assert match_score(a, b) == pytest.approx(0.0, abs=1e-6)


def test_opposite_vectors_clamped_to_zero_score() -> None:
    a = to_vector([1.0, 0.0])
    b = to_vector([-1.0, 0.0])
    assert cosine_similarity(a, b) == pytest.approx(-1.0)
    assert match_score(a, b) == 0.0  # saturado a [0,1]


def test_l2_normalize_unit_norm() -> None:
    v = to_vector([3.0, 4.0])
    n = l2_normalize(v)
    assert float(np.linalg.norm(n)) == pytest.approx(1.0)


def test_cosine_invariant_to_scale() -> None:
    a = to_vector([1.0, 2.0, 2.0])
    b = a * 7.5
    assert cosine_similarity(a, b) == pytest.approx(1.0)


def test_match_passes_at_threshold_090() -> None:
    # Construye dos vectores con coseno exactamente >= 0.90.
    base = np.array([1.0, 0.0], dtype=np.float32)
    angle = np.arccos(0.95)  # coseno 0.95 > 0.90
    near = np.array([np.cos(angle), np.sin(angle)], dtype=np.float32)
    outcome = verify_match(near, base, threshold=THRESHOLD)
    assert outcome.score == pytest.approx(0.95, abs=1e-4)
    assert outcome.passed is True
    assert is_match(outcome.score, THRESHOLD) is True


def test_match_fails_below_threshold() -> None:
    base = np.array([1.0, 0.0], dtype=np.float32)
    angle = np.arccos(0.85)  # coseno 0.85 < 0.90
    near = np.array([np.cos(angle), np.sin(angle)], dtype=np.float32)
    outcome = verify_match(near, base, threshold=THRESHOLD)
    assert outcome.score == pytest.approx(0.85, abs=1e-4)
    assert outcome.passed is False


def test_match_boundary_exactly_090_passes() -> None:
    # Score == umbral debe PASAR (comparación >=).
    base = np.array([1.0, 0.0], dtype=np.float32)
    angle = np.arccos(0.90)
    near = np.array([np.cos(angle), np.sin(angle)], dtype=np.float32)
    outcome = verify_match(near, base, threshold=THRESHOLD)
    assert outcome.score == pytest.approx(0.90, abs=1e-6)
    assert outcome.passed is True


def test_just_below_boundary_fails() -> None:
    assert is_match(0.8999, THRESHOLD) is False
    assert is_match(0.9000, THRESHOLD) is True


def test_realistic_512d_same_identity_passes(rng: np.random.Generator) -> None:
    # Dos capturas de la misma identidad ≈ embedding base + ruido pequeño.
    base = rng.standard_normal(512).astype(np.float32)
    probe = base + rng.standard_normal(512).astype(np.float32) * 0.05
    outcome = verify_match(probe, base, threshold=THRESHOLD)
    assert outcome.score >= THRESHOLD
    assert outcome.passed is True


def test_realistic_512d_different_identity_fails(rng: np.random.Generator) -> None:
    a = rng.standard_normal(512).astype(np.float32)
    b = rng.standard_normal(512).astype(np.float32)  # identidad distinta, independiente
    outcome = verify_match(a, b, threshold=THRESHOLD)
    assert outcome.score < THRESHOLD
    assert outcome.passed is False


def test_dimension_mismatch_raises() -> None:
    with pytest.raises(ValueError):
        cosine_similarity(to_vector([1.0, 2.0]), to_vector([1.0, 2.0, 3.0]))


def test_invalid_embedding_raises() -> None:
    with pytest.raises(ValueError):
        to_vector([])
    with pytest.raises(ValueError):
        to_vector([float("nan"), 1.0])
    with pytest.raises(ValueError):
        l2_normalize(np.zeros(4, dtype=np.float32))
