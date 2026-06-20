"""Tests del endpoint POST /v1/enroll (enrolamiento CON liveness, challenge-response).

Cubre el contrato HTTP sin ONNX/cv2: pipeline y store se sustituyen por dobles.
Casos: liveness PASS → embedding 512-d; liveness FAIL → embedding null + reason; challenge
inválido → livenessPassed=false + reason; límites anti-DoS (frames/tamaño) → 422; degradado → 503.
"""
from __future__ import annotations

import types
from typing import List, Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.config import Settings, get_settings
from app.face.liveness import ChallengeAction, LivenessResult
from app.face.pipeline import EnrollOutput
from app.main import create_app
from app.security.internal_identity import require_internal_identity


class _FakePipeline:
    """Doble del pipeline: contrato de enroll/best_detection/embed sin modelos ONNX."""

    def __init__(
        self,
        *,
        ready: bool = True,
        liveness: bool = True,
        reason: str = "ok",
        raise_value_error: bool = False,
    ) -> None:
        self.ready = ready
        self.load_error = None if ready else "Modelos ausentes (test)"
        self._liveness = liveness
        self._reason = reason
        self._raise = raise_value_error

    def load(self) -> None:  # noqa: D401 - no-op
        ...

    def enroll(
        self, *, action: object, challenge_valid: bool, frames_bgr: object
    ) -> EnrollOutput:
        if self._raise:
            raise ValueError("embedding mal formado")
        passed = bool(challenge_valid and self._liveness)
        reason = "ok" if passed else ("reto inválido/vencido" if not challenge_valid else self._reason)
        liveness = LivenessResult(passed=passed, action=ChallengeAction.TURN_LEFT, reason=reason)
        embedding = (
            np.linspace(0.0, 1.0, num=512, dtype=np.float32) if passed else None
        )
        return EnrollOutput(
            liveness=liveness,
            embedding=embedding,
            best_frame_index=0 if passed else None,
        )


class _FakeStore:
    def __init__(self, *, valid: bool = True) -> None:
        self._valid = valid

    def consume(self, _challenge_id: str) -> object:
        return types.SimpleNamespace(action=ChallengeAction.TURN_LEFT) if self._valid else None


def _build_client(
    monkeypatch: pytest.MonkeyPatch,
    pipeline: _FakePipeline,
    store: _FakeStore,
    *,
    settings: Settings | None = None,
) -> TestClient:
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    app = create_app()
    app.dependency_overrides[require_internal_identity] = lambda: None
    app.dependency_overrides[routes.get_pipeline] = lambda: pipeline
    app.dependency_overrides[routes.get_store] = lambda: store
    if settings is not None:
        app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def _body(*, frames: List[str] | None = None) -> dict:
    return {
        "driverId": "d1",
        "challengeId": "c1",
        "frames": frames if frames is not None else ["ZnJhbWU=", "ZnJhbWU=", "ZnJhbWU="],
    }


def test_enroll_happy_devuelve_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(liveness=True), _FakeStore(valid=True))
    res = client.post("/v1/enroll", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["livenessPassed"] is True
    assert body["reason"] is None
    embedding: Optional[List[float]] = body["embedding"]
    assert embedding is not None
    assert len(embedding) == 512
    assert "takenAt" in body


def test_enroll_liveness_fail_no_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(
        monkeypatch, _FakePipeline(liveness=False, reason="giro insuficiente"), _FakeStore(valid=True)
    )
    res = client.post("/v1/enroll", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["livenessPassed"] is False
    assert body["embedding"] is None
    assert body["reason"] == "giro insuficiente"


def test_enroll_challenge_invalido_no_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(liveness=True), _FakeStore(valid=False))
    res = client.post("/v1/enroll", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["livenessPassed"] is False
    assert body["embedding"] is None
    assert "inválido" in body["reason"].lower()


def test_enroll_domain_error_es_422_no_500(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(raise_value_error=True), _FakeStore(valid=True))
    res = client.post("/v1/enroll", json=_body())
    assert res.status_code == 422
    assert "inválida" in res.json()["detail"].lower()


def test_enroll_sin_frames_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=True))
    res = client.post("/v1/enroll", json=_body(frames=[]))
    assert res.status_code == 422


def test_enroll_demasiados_frames_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=True))
    res = client.post("/v1/enroll", json=_body(frames=["ZnJhbWU="] * 31))  # max_frames=30
    assert res.status_code == 422
    assert "frames" in res.json()["detail"].lower()


def test_enroll_imagen_muy_grande_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    small_limit = Settings(internal_identity_secret="x", require_auth=False, max_image_bytes=10)
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=True), settings=small_limit)
    res = client.post("/v1/enroll", json=_body(frames=["A" * 64]))  # ~48 bytes > 10
    assert res.status_code == 422
    assert "grande" in res.json()["detail"].lower()


def test_enroll_modo_degradado_es_503(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(ready=False), _FakeStore(valid=True))
    res = client.post("/v1/enroll", json=_body())
    assert res.status_code == 503
