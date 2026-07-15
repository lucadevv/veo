"""Matching facial por similitud coseno contra un embedding de referencia.

Matemática REAL (numpy puro): no depende de ONNX, por lo que es testeable con
vectores controlados. BR-I02: el match aprueba si la similitud coseno >= umbral. El umbral
es responsabilidad del caller (config: match_threshold para turno, doc_match_threshold para DNI).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

Vector = npt.NDArray[np.float32]

# Epsilon para evitar división por cero al normalizar vectores degenerados.
_EPS: float = 1e-8


def to_vector(values: object) -> Vector:
    """Convierte una secuencia de números a un vector float32 1-D.

    Lanza ValueError si la entrada no es un vector 1-D no vacío.
    """
    arr = np.asarray(values, dtype=np.float32)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError("El embedding debe ser un vector 1-D no vacío")
    if not np.all(np.isfinite(arr)):
        raise ValueError("El embedding contiene valores no finitos (NaN/Inf)")
    return arr


def l2_normalize(vector: Vector) -> Vector:
    """Normaliza L2 un vector. Devuelve el vector unitario (norma 1)."""
    norm = float(np.linalg.norm(vector))
    if norm < _EPS:
        raise ValueError("No se puede normalizar un vector de norma ~0")
    return (vector / norm).astype(np.float32)


def cosine_similarity(a: Vector, b: Vector) -> float:
    """Similitud coseno en [-1, 1] entre dos vectores de la misma dimensión.

    Robusta a vectores no normalizados (normaliza internamente).
    """
    if a.shape != b.shape:
        raise ValueError(
            f"Dimensiones incompatibles: {a.shape} vs {b.shape}"
        )
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < _EPS or nb < _EPS:
        raise ValueError("No se puede comparar un vector de norma ~0")
    sim = float(np.dot(a, b) / (na * nb))
    # Acota por errores de redondeo de punto flotante.
    return max(-1.0, min(1.0, sim))


def match_score(a: Vector, b: Vector) -> float:
    """Score de match en [0, 1].

    Mapea la similitud coseno [-1, 1] a [0, 1] de forma monótona. La identidad
    facial produce coseno >= 0; valores negativos (rostros muy distintos) se
    saturan a 0. Para coseno en [0, 1] el score equivale a la propia similitud.
    """
    return max(0.0, cosine_similarity(a, b))


def is_match(score: float, threshold: float) -> bool:
    """True si el score alcanza el umbral (>=). El umbral lo fija el caller por config (BR-I02)."""
    return score >= threshold


@dataclass(frozen=True)
class MatchOutcome:
    """Resultado del matching: score [0,1] y si pasa el umbral."""

    score: float
    passed: bool
    threshold: float


def verify_match(
    probe: Vector,
    reference: Vector,
    *,
    threshold: float,
) -> MatchOutcome:
    """Compara el embedding capturado contra el de referencia y aplica el umbral."""
    score = match_score(probe, reference)
    return MatchOutcome(score=score, passed=is_match(score, threshold), threshold=threshold)
