"""Auth interno server-to-server: valida la identidad firmada por HMAC que propaga el caller veo.

Réplica EXACTA (Python) del esquema canónico de `@veo/auth` (packages/auth/src/internal-identity.ts
+ packages/utils/src/crypto.ts):
  - header  `x-veo-identity`     = base64url(JSON({...user, issuedAt})) — SIN padding (Buffer.toString('base64url'))
  - header  `x-veo-identity-sig` = HMAC-SHA256(secret, header) en hex
  - verify  = comparación HMAC en tiempo constante + `issuedAt` dentro de `max_age_ms` (anti-replay, default 30s)

biometric es server-to-server: NO usa la identidad del usuario (recibe driverId en el body); solo VALIDA la
firma, lo que prueba que el caller conoce el secreto compartido (= es un servicio veo) y que el header es fresco.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Optional

from fastapi import Depends, Header, HTTPException, status

from app.config import Settings, get_settings

# Mismos nombres que packages/auth/src/internal-identity.ts (en minúscula: HTTP normaliza headers).
IDENTITY_HEADER = "x-veo-identity"
IDENTITY_SIG_HEADER = "x-veo-identity-sig"

# Ventana anti-replay por defecto: 30s (idéntica a verifyInternalIdentity opts.maxAgeMs).
DEFAULT_MAX_AGE_MS = 30_000


def _b64url_decode(value: str) -> bytes:
    """Decodifica base64url SIN padding (como lo emite Buffer.toString('base64url') de Node)."""
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def verify_internal_identity(
    header: str,
    signature: str,
    secret: str,
    *,
    max_age_ms: int = DEFAULT_MAX_AGE_MS,
    now_ms: Optional[float] = None,
) -> Optional[dict]:
    """Devuelve el payload de identidad si la firma es válida y el header es fresco; si no, None.

    `now_ms` se inyecta en tests para controlar el reloj; en runtime usa time.time().
    """
    if not header or not signature:
        return None
    expected = hmac.new(secret.encode("utf-8"), header.encode("utf-8"), hashlib.sha256).hexdigest()
    # Comparación en tiempo constante (espejo de timingSafeEqual sobre los dígitos hex).
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        identity = json.loads(_b64url_decode(header).decode("utf-8"))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None
    if not isinstance(identity, dict):
        return None
    issued_at = identity.get("issuedAt")
    if not isinstance(issued_at, (int, float)) or isinstance(issued_at, bool):
        return None
    current = time.time() * 1000 if now_ms is None else now_ms
    if current - issued_at > max_age_ms:
        return None
    return identity


def require_internal_identity(
    x_veo_identity: Optional[str] = Header(default=None, alias=IDENTITY_HEADER),
    x_veo_identity_sig: Optional[str] = Header(default=None, alias=IDENTITY_SIG_HEADER),
    settings: Settings = Depends(get_settings),
) -> Optional[dict]:
    """Dependency FastAPI para los endpoints /v1/*. 401 si la firma falta/es inválida/está vencida.

    Si `require_auth` está apagado, no exige nada (passthrough) — útil para entornos donde el gate lo
    impone la red/mTLS. Por defecto EXIGE auth (el control biométrico es el diferenciador no negociable).
    """
    if not settings.require_auth:
        return None
    if not settings.internal_identity_secret:
        # Fail-closed: auth requerida pero sin secreto configurado = misconfig, NO se deja pasar.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Auth interna habilitada pero VEO_BIO_INTERNAL_IDENTITY_SECRET no está configurado",
        )
    identity = verify_internal_identity(
        x_veo_identity or "",
        x_veo_identity_sig or "",
        settings.internal_identity_secret,
    )
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Identidad interna ausente, inválida o vencida",
        )
    return identity
