"""Tests del auth interno HMAC (réplica del esquema @veo/auth). Vectores controlados, sin red."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

from app.security.internal_identity import verify_internal_identity

SECRET = "test-internal-secret"


def _sign(identity: dict, secret: str = SECRET) -> tuple[str, str]:
    """Replica signInternalIdentity de @veo/auth: base64url(JSON) sin padding + HMAC-SHA256 hex."""
    header = base64.urlsafe_b64encode(json.dumps(identity).encode()).decode().rstrip("=")
    sig = hmac.new(secret.encode(), header.encode(), hashlib.sha256).hexdigest()
    return header, sig


def _identity(issued_at_ms: float) -> dict:
    return {"userId": "anonymous", "type": "driver", "roles": [], "sessionId": "", "issuedAt": issued_at_ms}


def test_firma_valida_y_fresca_devuelve_identidad() -> None:
    now = 1_000_000.0
    header, sig = _sign(_identity(now))
    result = verify_internal_identity(header, sig, SECRET, now_ms=now)
    assert result is not None
    assert result["type"] == "driver"


def test_header_o_firma_ausente_devuelve_none() -> None:
    header, sig = _sign(_identity(1_000_000.0))
    assert verify_internal_identity("", sig, SECRET, now_ms=1_000_000.0) is None
    assert verify_internal_identity(header, "", SECRET, now_ms=1_000_000.0) is None


def test_firma_adulterada_devuelve_none() -> None:
    header, _ = _sign(_identity(1_000_000.0))
    assert verify_internal_identity(header, "deadbeef", SECRET, now_ms=1_000_000.0) is None


def test_secreto_distinto_devuelve_none() -> None:
    header, sig = _sign(_identity(1_000_000.0), secret="otro-secreto")
    assert verify_internal_identity(header, sig, SECRET, now_ms=1_000_000.0) is None


def test_header_vencido_devuelve_none_anti_replay() -> None:
    issued = 1_000_000.0
    header, sig = _sign(_identity(issued))
    # 31s después: fuera de la ventana de 30s.
    assert verify_internal_identity(header, sig, SECRET, now_ms=issued + 31_000) is None
    # 29s después: dentro de la ventana.
    assert verify_internal_identity(header, sig, SECRET, now_ms=issued + 29_000) is not None


def test_header_sin_issued_at_devuelve_none() -> None:
    header, sig = _sign({"userId": "x", "type": "driver", "roles": [], "sessionId": ""})
    assert verify_internal_identity(header, sig, SECRET, now_ms=1_000_000.0) is None


def test_header_base64_corrupto_devuelve_none() -> None:
    # Firma válida sobre un header que NO es base64/JSON parseable.
    bad_header = "!!!no-es-base64!!!"
    sig = hmac.new(SECRET.encode(), bad_header.encode(), hashlib.sha256).hexdigest()
    assert verify_internal_identity(bad_header, sig, SECRET, now_ms=1_000_000.0) is None
