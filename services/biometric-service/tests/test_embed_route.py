"""Tests del endpoint POST /v1/embed (enrolamiento).

No requieren ONNX/cv2: se sustituye el pipeline por un doble que expone best_detection/embed
y se intercepta la decodificación de imagen. Se valida el contrato HTTP, no la inferencia real
(esa se cubre en test_matcher/test_decision/test_liveness con matemática aislada).
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.main import create_app


class _FakePipeline:
    """Doble del pipeline: simula detección de rostro y embedding sin modelos ONNX."""

    def __init__(self, faces: int) -> None:
        self._faces = faces
        self.ready = True
        self.load_error: Optional[str] = None

    def best_detection(self, _frame: object) -> Tuple[int, Optional[object]]:
        return (self._faces, object() if self._faces == 1 else None)

    def embed(self, _frame: object, _detection: object) -> np.ndarray:
        return np.linspace(0.0, 1.0, num=512, dtype=np.float32)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # La decodificación real necesita cv2; la sustituimos por un ndarray sintético.
    monkeypatch.setattr(routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8))
    app = create_app()
    return TestClient(app)


def _use_pipeline(client: TestClient, faces: int) -> None:
    client.app.dependency_overrides[routes.get_pipeline] = lambda: _FakePipeline(faces)


def test_embed_devuelve_embedding_con_un_rostro(client: TestClient) -> None:
    _use_pipeline(client, faces=1)
    res = client.post("/v1/embed", json={"photo": "Zm90bw=="})
    assert res.status_code == 200
    body = res.json()
    embedding: List[float] = body["embedding"]
    assert body["dimensions"] == 512
    assert len(embedding) == 512


def test_embed_rechaza_si_no_hay_exactamente_un_rostro(client: TestClient) -> None:
    _use_pipeline(client, faces=0)
    res = client.post("/v1/embed", json={"photo": "Zm90bw=="})
    assert res.status_code == 422


def test_embed_rechaza_foto_vacia(client: TestClient) -> None:
    _use_pipeline(client, faces=1)
    res = client.post("/v1/embed", json={"photo": ""})
    assert res.status_code == 422
