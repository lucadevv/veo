"""Tests del RedisChallengeStore (multi-réplica) con un fake de redis-py (setex/getdel).

Verifica el contrato crítico: un solo uso (GETDEL atómico → anti-replay distribuido), reto desconocido
→ None, y vencido → None. Sin Redis real."""
from __future__ import annotations

from typing import Dict, Optional

from app.challenge_store import InMemoryChallengeStore, RedisChallengeStore
from app.config import Settings
from app.face.liveness import ChallengeAction
from app.main import build_challenge_store


class _FakeRedis:
    """Subconjunto de redis-py: setex (guarda) + getdel (GET + DEL atómico)."""

    def __init__(self) -> None:
        self._d: Dict[str, str] = {}

    def setex(self, name: str, time: int, value: str) -> object:  # noqa: A002 - firma redis-py
        self._d[name] = value
        return True

    def getdel(self, name: str) -> Optional[bytes]:
        v = self._d.pop(name, None)
        return v.encode() if isinstance(v, str) else None


def test_issue_y_consume_devuelve_el_reto() -> None:
    store = RedisChallengeStore(_FakeRedis(), ttl_seconds=60)
    issued = store.issue(ChallengeAction.NOD)
    got = store.consume(issued.challenge_id)
    assert got is not None
    assert got.action is ChallengeAction.NOD
    assert got.challenge_id == issued.challenge_id


def test_un_solo_uso_anti_replay() -> None:
    store = RedisChallengeStore(_FakeRedis(), ttl_seconds=60)
    issued = store.issue(ChallengeAction.TURN_LEFT)
    assert store.consume(issued.challenge_id) is not None
    # Segundo consume del MISMO id → None (GETDEL ya lo borró). Anti-replay distribuido.
    assert store.consume(issued.challenge_id) is None


def test_reto_desconocido_devuelve_none() -> None:
    store = RedisChallengeStore(_FakeRedis(), ttl_seconds=60)
    assert store.consume("no-existe") is None


def test_reto_vencido_devuelve_none() -> None:
    # ttl negativo ⇒ expires_at en el pasado ⇒ is_expired True al consumir.
    store = RedisChallengeStore(_FakeRedis(), ttl_seconds=-1)
    issued = store.issue(ChallengeAction.SMILE)
    assert store.consume(issued.challenge_id) is None


def test_factory_sin_redis_url_usa_in_memory() -> None:
    store = build_challenge_store(Settings(internal_identity_secret="x", require_auth=False))
    assert isinstance(store, InMemoryChallengeStore)
