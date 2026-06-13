"""Tests del endpoint POST /v1/verify (modo JSON). Cubre el contrato HTTP que faltaba:
happy PASS, challenge inválido→BLOCKED, referenceEmbedding inválido→422 (NO 500), límites anti-DoS
(frames/tamaño)→422 y modo degradado→503. Sin ONNX: pipeline y store se sustituyen por dobles."""
from __future__ import annotations

import types
from typing import List

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.config import Settings, get_settings
from app.domain import DecisionInput, decide
from app.face.liveness import ChallengeAction
from app.face.pipeline import PipelineOutput
from app.main import create_app
from app.security.internal_identity import require_internal_identity

_THRESHOLD = 0.90


class _FakePipeline:
    """Doble del pipeline: contrato de verify/best_detection/embed sin modelos ONNX."""

    def __init__(
        self,
        *,
        ready: bool = True,
        faces: int = 1,
        liveness: bool = True,
        score: float = 0.95,
        raise_value_error: bool = False,
    ) -> None:
        self.ready = ready
        self.load_error = None if ready else "Modelos ausentes (test)"
        self._faces = faces
        self._liveness = liveness
        self._score = score
        self._raise = raise_value_error

    def load(self) -> None:  # noqa: D401 - no-op
        ...

    def best_detection(self, _frame: object) -> tuple[int, object]:
        return (1, object())

    def embed(self, _frame: object, _detection: object) -> np.ndarray:
        return np.linspace(0.0, 1.0, num=512, dtype=np.float32)

    def verify(self, *, action: object, challenge_valid: bool, frames_bgr: object, reference_embedding: object) -> PipelineOutput:
        if self._raise:
            # Simula el ValueError real del matcher ante un embedding de dim incompatible/NaN.
            raise ValueError("Dimensiones incompatibles: (128,) vs (512,)")
        decision = decide(
            DecisionInput(
                challenge_valid=challenge_valid,
                faces_detected=self._faces,
                liveness_passed=self._liveness,
                match_score=self._score,
                match_threshold=_THRESHOLD,
            )
        )
        return PipelineOutput(
            decision=decision,
            liveness=types.SimpleNamespace(passed=self._liveness),
            faces_in_primary_frame=self._faces,
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


def _body(*, frames: List[str] | None = None, reference_embedding: List[float] | None = None) -> dict:
    return {
        "driverId": "d1",
        "challengeId": "c1",
        "frames": frames if frames is not None else ["ZnJhbWU="],
        "referenceEmbedding": reference_embedding if reference_embedding is not None else [0.1] * 512,
    }


def test_verify_happy_devuelve_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(liveness=True, score=0.95), _FakeStore(valid=True))
    res = client.post("/v1/verify", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["result"] == "PASS"
    assert body["livenessPassed"] is True
    assert body["matchPassed"] is True


def test_verify_challenge_invalido_devuelve_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=False))
    res = client.post("/v1/verify", json=_body())
    assert res.status_code == 200
    assert res.json()["result"] == "BLOCKED"


def test_verify_reference_embedding_invalido_es_422_no_500(monkeypatch: pytest.MonkeyPatch) -> None:
    # EL P0: un referenceEmbedding de dim incompatible/NaN reventaba como 500. Ahora → 422.
    client = _build_client(monkeypatch, _FakePipeline(raise_value_error=True), _FakeStore(valid=True))
    res = client.post("/v1/verify", json=_body(reference_embedding=[0.1] * 128))
    assert res.status_code == 422
    assert "inválida" in res.json()["detail"].lower()


def test_verify_demasiados_frames_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=True))
    res = client.post("/v1/verify", json=_body(frames=["ZnJhbWU="] * 31))  # max_frames=30
    assert res.status_code == 422
    assert "frames" in res.json()["detail"].lower()


def test_verify_imagen_muy_grande_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    small_limit = Settings(internal_identity_secret="x", require_auth=False, max_image_bytes=10)
    client = _build_client(monkeypatch, _FakePipeline(), _FakeStore(valid=True), settings=small_limit)
    res = client.post("/v1/verify", json=_body(frames=["A" * 64]))  # ~48 bytes > 10
    assert res.status_code == 422
    assert "grande" in res.json()["detail"].lower()


def test_verify_modo_degradado_es_503(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(ready=False), _FakeStore(valid=True))
    res = client.post("/v1/verify", json=_body())
    assert res.status_code == 503
