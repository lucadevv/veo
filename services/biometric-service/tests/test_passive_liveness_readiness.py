"""Tests de readiness HONESTO del PAD anti-spoofing (F2) + el endpoint /v1/enroll-passive.

Verifica que:
  - /health/ready exponga `passiveLivenessLoaded` (no solo detector+embedder),
  - sea FAIL-CLOSED en prod (`require_passive_liveness=True` → 503 si el PAD no está → el pod no entra al
    balanceador → el registro nunca enrola sin anti-spoofing),
  - en dev (require=False) degrade VISIBLE (200 pero passiveLivenessLoaded=false),
  - /v1/enroll-passive: spoof → embedding null + reason; real → embedding; PAD ausente → degradado honesto.
Sin ONNX/cv2: pipeline doble.
"""
from __future__ import annotations

import types
from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.config import Settings, get_settings
from app.main import create_app
from app.security.internal_identity import require_internal_identity


class _FakePipeline:
    """Doble del pipeline: readiness + enrol pasivo sin modelos ONNX."""

    def __init__(
        self,
        *,
        ready: bool = True,
        pad_loaded: bool = True,
        face_count: int = 1,
        verdict: Optional[object] = None,
    ) -> None:
        self.ready = ready
        self.passive_liveness_loaded = pad_loaded
        self.load_error = None if ready else "Modelos ausentes (test)"
        self._face_count = face_count
        self._verdict = verdict

    def load(self) -> None:  # noqa: D401 - no-op
        ...

    def best_detection(self, _image: object) -> tuple[int, object]:
        detection = object() if self._face_count == 1 else None
        return self._face_count, detection

    def classify_liveness(self, _image: object, _detection: object) -> Optional[object]:
        return self._verdict

    def embed(self, _image: object, _detection: object) -> np.ndarray:
        return np.linspace(0.0, 1.0, num=512, dtype=np.float32)


def _verdict(*, live: bool, score: float) -> object:
    return types.SimpleNamespace(live=live, score=score)


def _client(pipeline: _FakePipeline, *, settings: Settings | None = None) -> TestClient:
    app = create_app()
    app.dependency_overrides[routes.get_pipeline] = lambda: pipeline
    app.dependency_overrides[require_internal_identity] = lambda: None
    if settings is not None:
        app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


# ── /health/ready ──────────────────────────────────────────────────────────────────────────────────────

def test_ready_pad_cargado_expone_flag_true() -> None:
    res = _client(_FakePipeline(ready=True, pad_loaded=True)).get("/health/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["ready"] is True
    assert body["modelsLoaded"] is True
    assert body["passiveLivenessLoaded"] is True


def test_ready_dev_sin_pad_degrada_visible_pero_listo() -> None:
    # require_passive_liveness=False (dev): el pod queda LISTO igual, pero el flag expone el modo degradado.
    settings = Settings(require_passive_liveness=False)
    res = _client(_FakePipeline(ready=True, pad_loaded=False), settings=settings).get("/health/ready")
    assert res.status_code == 200
    assert res.json()["ready"] is True
    assert res.json()["passiveLivenessLoaded"] is False


def test_ready_prod_sin_pad_failclosed_503() -> None:
    # require_passive_liveness=True (prod): sin PAD el pod NO se reporta listo → no entra al balanceador.
    settings = Settings(require_passive_liveness=True)
    res = _client(_FakePipeline(ready=True, pad_loaded=False), settings=settings).get("/health/ready")
    assert res.status_code == 503
    assert res.json()["ready"] is False
    assert res.json()["passiveLivenessLoaded"] is False


def test_ready_sin_modelos_503_aunque_no_se_exija_pad() -> None:
    # Sin detector/embedder NO hay readiness, exija o no el PAD (gate previo intacto).
    settings = Settings(require_passive_liveness=False)
    res = _client(_FakePipeline(ready=False, pad_loaded=False), settings=settings).get("/health/ready")
    assert res.status_code == 503
    assert res.json()["ready"] is False


# ── /v1/enroll-passive ─────────────────────────────────────────────────────────────────────────────────

def _enroll(client: TestClient) -> object:
    return client.post("/v1/enroll-passive", json={"photo": "Zm90bw=="})


def test_enroll_passive_spoof_no_enrola(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    client = _client(_FakePipeline(verdict=_verdict(live=False, score=0.2)))
    res = _enroll(client)
    assert res.status_code == 200
    body = res.json()
    assert body["embedding"] is None
    assert body["live"] is False
    assert body["livenessChecked"] is True
    assert body["reason"] == "spoof"


def test_enroll_passive_persona_real_devuelve_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    client = _client(_FakePipeline(verdict=_verdict(live=True, score=0.95)))
    res = _enroll(client)
    assert res.status_code == 200
    body = res.json()
    assert body["embedding"] is not None
    assert len(body["embedding"]) == 512
    assert body["live"] is True
    assert body["livenessChecked"] is True


def test_enroll_passive_pad_ausente_degrada_honesto(monkeypatch: pytest.MonkeyPatch) -> None:
    # PAD no cargado → classify_liveness devuelve None → enrola SIN liveness (livenessChecked=false), honesto.
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    client = _client(_FakePipeline(pad_loaded=False, verdict=None))
    res = _enroll(client)
    assert res.status_code == 200
    body = res.json()
    assert body["embedding"] is not None
    assert body["livenessChecked"] is False


def test_enroll_passive_sin_rostro_422(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    client = _client(_FakePipeline(face_count=0))
    res = _enroll(client)
    assert res.status_code == 422
