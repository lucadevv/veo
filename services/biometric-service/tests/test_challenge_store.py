"""Tests del almacén de retos (un solo uso, expiración → anti-replay)."""
from __future__ import annotations

import time

from app.challenge_store import InMemoryChallengeStore
from app.face.liveness import ChallengeAction


def test_issue_and_consume() -> None:
    store = InMemoryChallengeStore(ttl_seconds=60)
    ch = store.issue(ChallengeAction.SMILE)
    assert ch.action is ChallengeAction.SMILE
    got = store.consume(ch.challenge_id)
    assert got is not None
    assert got.challenge_id == ch.challenge_id


def test_single_use_consume() -> None:
    store = InMemoryChallengeStore(ttl_seconds=60)
    ch = store.issue(ChallengeAction.NOD)
    assert store.consume(ch.challenge_id) is not None
    # Segundo consumo del mismo reto → None (anti-replay).
    assert store.consume(ch.challenge_id) is None


def test_unknown_challenge_returns_none() -> None:
    store = InMemoryChallengeStore(ttl_seconds=60)
    assert store.consume("no-existe") is None


def test_expired_challenge_returns_none() -> None:
    store = InMemoryChallengeStore(ttl_seconds=0)
    ch = store.issue(ChallengeAction.TURN_LEFT)
    time.sleep(0.01)
    assert store.consume(ch.challenge_id) is None
