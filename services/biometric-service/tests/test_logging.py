"""Tests del logging estructurado JSON (audit trail Ley 29733)."""
from __future__ import annotations

import json
import logging

from app.logging_setup import JsonFormatter


def _record(msg: str, **extra: object) -> logging.LogRecord:
    rec = logging.LogRecord("biometric", logging.INFO, __file__, 1, msg, None, None)
    for k, v in extra.items():
        setattr(rec, k, v)
    return rec


def test_json_formatter_serializa_campos_base_y_extra() -> None:
    out = json.loads(JsonFormatter().format(_record("biometric.verify", driverId="d1", result="PASS")))
    assert out["message"] == "biometric.verify"
    assert out["level"] == "INFO"
    assert out["logger"] == "biometric"
    assert out["driverId"] == "d1"
    assert out["result"] == "PASS"
    assert "timestamp" in out


def test_json_formatter_no_filtra_atributos_reservados() -> None:
    out = json.loads(JsonFormatter().format(_record("hola")))
    # Ruido del LogRecord NO debe aparecer como campos estructurados.
    for noisy in ("pathname", "args", "lineno", "funcName", "process"):
        assert noisy not in out
