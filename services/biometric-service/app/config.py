"""Configuración del servicio (pydantic-settings, 12-factor: todo por env)."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración tipada cargada desde variables de entorno (prefijo VEO_BIO_)."""

    model_config = SettingsConfigDict(
        env_prefix="VEO_BIO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- HTTP ---
    host: str = "0.0.0.0"
    port: int = 3015
    service_name: str = "biometric-service"

    # --- Modelos ONNX ---
    model_dir: str = "models"
    # buffalo_l: detector SCRFD-10G (det_10g.onnx) + recognizer ArcFace (w600k_r50.onnx).
    detector_model: str = "det_10g.onnx"
    embedder_model: str = "w600k_r50.onnx"
    # Proveedores onnxruntime en orden de preferencia.
    onnx_providers: tuple[str, ...] = ("CPUExecutionProvider",)
    # Si es True, el servicio falla en /verify cuando los modelos no están presentes.
    # Si es False, /verify devuelve 503 (degradado) pero el servicio arranca igual.
    require_models: bool = False

    # --- Detección ---
    detection_size: int = 640
    detection_threshold: float = 0.5
    # Tamaño mínimo (px) del rostro detectado para considerarlo "claro".
    min_face_size: int = 80

    # --- Matching (BR-I02: umbral 0.90) ---
    match_threshold: float = Field(default=0.90, ge=0.0, le=1.0)

    # --- Liveness activo (por reto) ---
    challenge_ttl_seconds: int = 60
    min_frames_for_liveness: int = 3
    # Umbrales geométricos (grados / ratios normalizados por distancia interocular).
    yaw_turn_degrees: float = 18.0
    pitch_nod_degrees: float = 12.0
    blink_ear_threshold: float = 0.21
    eye_open_ear_threshold: float = 0.28
    smile_ratio_threshold: float = 1.45
    mouth_open_ratio_threshold: float = 0.35
    # Retos disponibles. Por defecto solo los soportados por landmarks de 5 puntos
    # (SCRFD). BLINK/OPEN_MOUTH requieren un modelo de landmarks densos (ver README).
    liveness_actions: tuple[str, ...] = ("TURN_LEFT", "TURN_RIGHT", "NOD", "SMILE")
    # Escalas de calibración pose (grados por unidad de ratio normalizado interocular).
    yaw_scale_deg: float = 90.0
    pitch_scale_deg: float = 70.0

    # --- Observabilidad ---
    otel_enabled: bool = False
    otel_exporter_otlp_endpoint: str = ""
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Settings cacheado (singleton) para inyección de dependencias en FastAPI."""
    return Settings()
