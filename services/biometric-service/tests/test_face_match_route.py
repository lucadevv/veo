"""Tests del endpoint POST /v1/face-match (rostro del DNI vs selfie enrolada).

No requieren ONNX/cv2: se sustituye el pipeline por un doble que expone best_detection/embed
y se intercepta la decodificación de imagen. Se valida el contrato HTTP y la degradación honesta
(sin rostro / varios → matched=false+reason; modelos ausentes → 503; entrada mal formada → 422).
La matemática real (coseno/umbral) se cubre en test_matcher con vectores controlados.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.main import create_app
from app.security.internal_identity import require_internal_identity


class _FakePipeline:
    """Doble del pipeline: simula detección + embedding sin modelos ONNX.

    `embedding` controla el vector devuelto por embed() para forzar match alto/bajo contra
    la referencia. `faces` controla cuántos rostros "ve" best_detection en el DNI.
    """

    def __init__(
        self,
        *,
        ready: bool = True,
        faces: int = 1,
        embedding: Optional[np.ndarray] = None,
    ) -> None:
        self.ready = ready
        self.load_error = None if ready else "Modelos ausentes (test)"
        self._faces = faces
        self._embedding = (
            embedding
            if embedding is not None
            else np.ones(512, dtype=np.float32)
        )

    def load(self) -> None:  # noqa: D401 - no-op
        ...

    def best_detection(self, _frame: object) -> Tuple[int, Optional[object]]:
        return (self._faces, object() if self._faces == 1 else None)

    def embed(self, _frame: object, _detection: object) -> np.ndarray:
        return self._embedding


def _build_client(
    monkeypatch: pytest.MonkeyPatch,
    pipeline: _FakePipeline,
) -> TestClient:
    # La decodificación real necesita cv2; la sustituimos por un ndarray sintético.
    monkeypatch.setattr(
        routes, "decode_base64_image", lambda _b64: np.zeros((4, 4, 3), dtype=np.uint8)
    )
    app = create_app()
    app.dependency_overrides[require_internal_identity] = lambda: None
    app.dependency_overrides[routes.get_pipeline] = lambda: pipeline
    return TestClient(app)


def _body(*, image: str = "Zm90bw==", reference: Optional[List[float]] = None) -> dict:
    return {
        "image": image,
        "referenceEmbedding": reference if reference is not None else [1.0] * 512,
    }


def test_face_match_mismo_embedding_matchea(monkeypatch: pytest.MonkeyPatch) -> None:
    # embed() devuelve el MISMO vector que la referencia → coseno ~1.0 → matched.
    ref = np.linspace(0.1, 1.0, num=512, dtype=np.float32)
    client = _build_client(monkeypatch, _FakePipeline(embedding=ref))
    res = client.post("/v1/face-match", json=_body(reference=ref.tolist()))
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is True
    assert body["score"] >= 0.99
    assert body["reason"] is None


def test_face_match_embedding_distinto_no_matchea(monkeypatch: pytest.MonkeyPatch) -> None:
    # Vector del DNI ortogonal/opuesto a la referencia → coseno bajo → no match + reason.
    probe = np.full(512, -1.0, dtype=np.float32)
    ref = np.full(512, 1.0, dtype=np.float32)
    client = _build_client(monkeypatch, _FakePipeline(embedding=probe))
    res = client.post("/v1/face-match", json=_body(reference=ref.tolist()))
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is False
    assert body["score"] < 0.40
    assert body["reason"] is not None
    assert "umbral" in body["reason"].lower()


def test_face_match_sin_rostro_es_matched_false_con_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(faces=0))
    res = client.post("/v1/face-match", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is False
    assert body["score"] == 0.0
    assert "no se detect" in body["reason"].lower()


def test_face_match_varios_rostros_es_matched_false_con_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(faces=2))
    res = client.post("/v1/face-match", json=_body())
    assert res.status_code == 200
    body = res.json()
    assert body["matched"] is False
    assert body["score"] == 0.0
    assert "2 rostros" in body["reason"]


def test_face_match_imagen_mal_formada_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    # decode_base64_image real lanza ValueError ante base64 inválido → 422.
    def _raise(_b64: str) -> np.ndarray:
        raise ValueError("base64 inválido")

    monkeypatch.setattr(routes, "decode_base64_image", _raise)
    app = create_app()
    app.dependency_overrides[require_internal_identity] = lambda: None
    app.dependency_overrides[routes.get_pipeline] = lambda: _FakePipeline()
    client = TestClient(app)
    res = client.post("/v1/face-match", json=_body(image="@@@nob64@@@"))
    assert res.status_code == 422
    assert "inválida" in res.json()["detail"].lower()


def test_face_match_reference_embedding_dim_incompatible_es_422(monkeypatch: pytest.MonkeyPatch) -> None:
    # Referencia de dim≠ a la del embedding del DNI → cosine_similarity lanza ValueError →
    # 422 (NO 500), traducido por _domain_errors_as_422. Probe de 512, referencia de 128.
    probe = np.ones(512, dtype=np.float32)
    client = _build_client(monkeypatch, _FakePipeline(embedding=probe))
    res = client.post("/v1/face-match", json=_body(reference=[0.1] * 128))
    assert res.status_code == 422
    assert "inválida" in res.json()["detail"].lower()


def test_face_match_modo_degradado_es_503(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _build_client(monkeypatch, _FakePipeline(ready=False))
    res = client.post("/v1/face-match", json=_body())
    assert res.status_code == 503
