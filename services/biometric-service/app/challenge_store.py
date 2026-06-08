"""Almacén de retos de liveness activos (challenge-response).

Implementación in-memory thread-safe con expiración. Para despliegues multi-réplica
se debe sustituir por un store distribuido (Redis) detrás de la misma interfaz
`ChallengeStore` (principio D: depender de la abstracción). Aquí entregamos una
implementación REAL y completa para una réplica.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from app.face.liveness import ChallengeAction


@dataclass(frozen=True)
class Challenge:
    """Reto emitido al cliente, con vencimiento."""

    challenge_id: str
    action: ChallengeAction
    created_at: float
    expires_at: float

    def is_expired(self, now: float) -> bool:
        return now >= self.expires_at


class ChallengeStore(Protocol):
    """Interfaz del almacén de retos (segregada, principio I)."""

    def issue(self, action: ChallengeAction) -> Challenge: ...

    def consume(self, challenge_id: str) -> Challenge | None: ...


class InMemoryChallengeStore:
    """Store in-memory con lock y limpieza perezosa de retos vencidos."""

    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._items: dict[str, Challenge] = {}

    def issue(self, action: ChallengeAction) -> Challenge:
        now = time.time()
        challenge = Challenge(
            challenge_id=secrets.token_urlsafe(24),
            action=action,
            created_at=now,
            expires_at=now + self._ttl,
        )
        with self._lock:
            self._gc(now)
            self._items[challenge.challenge_id] = challenge
        return challenge

    def consume(self, challenge_id: str) -> Challenge | None:
        """Devuelve y ELIMINA el reto (un solo uso → anti-replay). None si no existe/vencido."""
        now = time.time()
        with self._lock:
            self._gc(now)
            challenge = self._items.pop(challenge_id, None)
        if challenge is None or challenge.is_expired(now):
            return None
        return challenge

    def _gc(self, now: float) -> None:
        expired = [cid for cid, c in self._items.items() if c.is_expired(now)]
        for cid in expired:
            self._items.pop(cid, None)
