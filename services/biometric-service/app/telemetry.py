"""Observabilidad: métricas Prometheus y tracing OpenTelemetry."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from app.config import Settings

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger("biometric")

# --- Métricas de dominio ---
VERIFY_TOTAL = Counter(
    "veo_biometric_verify_total",
    "Verificaciones biométricas por resultado",
    labelnames=("result",),
)
LIVENESS_TOTAL = Counter(
    "veo_biometric_liveness_total",
    "Evaluaciones de liveness por veredicto",
    labelnames=("passed",),
)
CHALLENGE_ISSUED_TOTAL = Counter(
    "veo_biometric_challenge_issued_total",
    "Retos de liveness emitidos por acción",
    labelnames=("action",),
)
MATCH_SCORE = Histogram(
    "veo_biometric_match_score",
    "Distribución de scores de match (similitud coseno)",
    buckets=(0.0, 0.5, 0.7, 0.8, 0.85, 0.9, 0.92, 0.95, 0.98, 1.0),
)
VERIFY_LATENCY = Histogram(
    "veo_biometric_verify_seconds",
    "Latencia del endpoint /verify en segundos",
)
FACE_MATCH_TOTAL = Counter(
    "veo_biometric_face_match_total",
    "Comparaciones rostro-DNI vs selfie enrolada por veredicto",
    labelnames=("matched",),
)
FACE_MATCH_LATENCY = Histogram(
    "veo_biometric_face_match_seconds",
    "Latencia del endpoint /face-match en segundos",
)
ENROLL_PASSIVE_TOTAL = Counter(
    "veo_biometric_enroll_passive_total",
    "Enrolamientos pasivos del registro (PAD anti-spoofing) por resultado",
    labelnames=("result",),  # enrolled | spoof | no_face | degraded (PAD ausente → enrolado sin liveness)
)
SPOOF_SCORE = Histogram(
    "veo_biometric_spoof_score",
    "Distribución del score de vida del PAD anti-spoofing en el enrol pasivo (1.0 = vivo)",
    buckets=(0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)


def metrics_payload() -> tuple[bytes, str]:
    """Cuerpo y content-type para el endpoint /metrics."""
    return generate_latest(), CONTENT_TYPE_LATEST


def setup_telemetry(app: "FastAPI", settings: Settings) -> None:
    """Configura logging estructurado JSON + OpenTelemetry (tracing) si está habilitado por env."""
    from app.logging_setup import configure_logging

    configure_logging(settings.log_level)
    if not settings.otel_enabled:
        return
    try:
        from opentelemetry import trace
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create({SERVICE_NAME: settings.service_name})
        provider = TracerProvider(resource=resource)
        if settings.otel_exporter_otlp_endpoint:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )

            provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint)
                )
            )
        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app)
        logger.info("OpenTelemetry habilitado para %s", settings.service_name)
    except Exception as exc:  # noqa: BLE001 — OTel no debe tumbar el servicio.
        logger.warning("No se pudo inicializar OpenTelemetry: %s", exc)
