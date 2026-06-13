"""Logging estructurado JSON (sin dependencias extra) — alineado con la flota veo.

Cada línea es un objeto JSON con timestamp ISO, nivel, logger y mensaje, más cualquier campo
`extra={...}` que el caller adjunte (p. ej. el audit trail de verificación: driverId/shiftId/result/score).
NUNCA se loguea PII biométrica (embeddings/imágenes) — solo IDs y veredicto."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

# Atributos estándar de LogRecord: todo lo que NO esté acá se trata como campo estructurado `extra`.
_RESERVED = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module",
        "exc_info", "exc_text", "stack_info", "lineno", "funcName", "created", "msecs",
        "relativeCreated", "thread", "threadName", "processName", "process", "taskName",
    }
)


class JsonFormatter(logging.Formatter):
    """Serializa cada LogRecord a una línea JSON, incluyendo los campos `extra`."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str) -> None:
    """Instala el handler JSON en el root logger (idempotente)."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level, logging.INFO))
