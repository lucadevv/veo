"""Punto de entrada FastAPI del biometric-service (VEO)."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app import __version__
from app.api.routes import router
from app.challenge_store import ChallengeStore, InMemoryChallengeStore, RedisChallengeStore
from app.config import Settings, get_settings
from app.face.pipeline import BiometricPipeline
from app.telemetry import setup_telemetry

logger = logging.getLogger("biometric")


def build_challenge_store(settings: Settings) -> ChallengeStore:
    """In-memory por defecto (una réplica); Redis si hay VEO_BIO_REDIS_URL (multi-réplica del HPA)."""
    if settings.redis_url:
        import redis  # import perezoso: solo si se usa el modo distribuido.

        client = redis.Redis.from_url(settings.redis_url)
        logger.info("ChallengeStore: Redis (multi-réplica)")
        return RedisChallengeStore(client, settings.challenge_ttl_seconds)
    logger.info("ChallengeStore: in-memory (una réplica)")
    return InMemoryChallengeStore(settings.challenge_ttl_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    app.state.settings = settings
    app.state.challenge_store = build_challenge_store(settings)
    pipeline = BiometricPipeline(settings)
    app.state.pipeline = pipeline
    # Intenta cargar modelos al arrancar (no bloquea el arranque salvo require_models).
    try:
        pipeline.load()
        if pipeline.ready:
            logger.info("Modelos ONNX cargados desde %s", settings.model_dir)
        else:
            logger.warning("Servicio en modo degradado: %s", pipeline.load_error)
    except RuntimeError as exc:
        logger.error("Fallo al cargar modelos (require_models=True): %s", exc)
        raise
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="VEO biometric-service",
        version=__version__,
        description="Verificación facial self-hosted (FastAPI + ONNX): detección, "
        "liveness activo, embeddings ArcFace y match coseno (BR-I02).",
        lifespan=lifespan,
    )
    setup_telemetry(app, settings)
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    _settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=_settings.host,
        port=_settings.port,
        log_level=_settings.log_level.lower(),
    )
