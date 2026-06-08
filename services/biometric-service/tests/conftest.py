"""Fixtures comunes. Solo dependen de numpy (sin ONNX/cv2)."""
from __future__ import annotations

import numpy as np
import pytest

from app.face.liveness import LivenessThresholds


@pytest.fixture
def thresholds() -> LivenessThresholds:
    return LivenessThresholds()


@pytest.fixture
def rng() -> np.random.Generator:
    return np.random.default_rng(seed=42)
