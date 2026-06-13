"""Almacén de retos de liveness activos (challenge-response).

Dos implementaciones detrás del mismo Protocol `ChallengeStore` (principio D: depender de la
abstracción):
  - `InMemoryChallengeStore`: thread-safe, una réplica (dev / single-pod).
  - `RedisChallengeStore`: distribuido, MULTI-RÉPLICA. El HPA escala 2–10 pods; con el store
    in-memory un reto emitido por el pod A y verificado en el B daría BLOCKED espurio. Redis lo
    centraliza y mantiene el anti-replay (un solo uso) con `GETDEL` ATÓMICO entre réplicas.
"""
from __future__ import annotations

import json
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Optional, Protocol

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


class RedisLike(Protocol):
    """Subconjunto de redis-py que usa el store (permite testear sin un Redis real)."""

    def setex(self, name: str, time: int, value: str) -> object: ...

    def getdel(self, name: str) -> Optional[bytes]: ...


class RedisChallengeStore:
    """Store distribuido para MULTI-RÉPLICA. El reto vive en Redis con TTL (limpieza automática, sin
    GC manual); `consume` usa GETDEL (GET + DEL atómico) → un solo uso aunque dos réplicas lo consuman
    a la vez: el anti-replay se mantiene entre pods."""

    _PREFIX = "veo:bio:challenge:"

    def __init__(self, client: RedisLike, ttl_seconds: int) -> None:
        self._redis = client
        self._ttl = ttl_seconds

    def _key(self, challenge_id: str) -> str:
        return f"{self._PREFIX}{challenge_id}"

    def issue(self, action: ChallengeAction) -> Challenge:
        now = time.time()
        challenge = Challenge(
            challenge_id=secrets.token_urlsafe(24),
            action=action,
            created_at=now,
            expires_at=now + self._ttl,
        )
        payload = json.dumps(
            {"action": action.value, "created_at": now, "expires_at": challenge.expires_at}
        )
        self._redis.setex(self._key(challenge.challenge_id), self._ttl, payload)
        return challenge

    def consume(self, challenge_id: str) -> Optional[Challenge]:
        raw = self._redis.getdel(self._key(challenge_id))
        if raw is None:
            return None
        try:
            data = json.loads(raw)
            action = ChallengeAction(data["action"])
            challenge = Challenge(
                challenge_id=challenge_id,
                action=action,
                created_at=float(data["created_at"]),
                expires_at=float(data["expires_at"]),
            )
        except (ValueError, KeyError, TypeError):
            return None
        if challenge.is_expired(time.time()):
            return None
        return challenge
