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

    # --- Auth interna server-to-server (HMAC, esquema @veo/auth) ---
    # Secreto compartido con identity-service (VEO_BIO_INTERNAL_IDENTITY_SECRET). Vacío + require_auth=True
    # => fail-closed (500), nunca se deja pasar sin gate. Ver app/security/internal_identity.py.
    internal_identity_secret: str = ""
    # Exige la identidad interna firmada en /v1/*. Default True: el control biométrico es el diferenciador
    # no negociable. Solo apagar si el gate lo impone otra capa (mTLS/red) y se documenta.
    require_auth: bool = True

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

    # --- Límites de entrada (anti-DoS: el caller manda N frames + foto de referencia) ---
    # Cantidad máxima de frames por /verify (suficiente para liveness; corta amplificación de cómputo).
    max_frames: int = Field(default=30, ge=1)
    # Tamaño máximo (bytes) de cada imagen decodificada/recibida. 8 MiB cubre fotos de cámara de móvil
    # y frena decompression bombs / OOM.
    max_image_bytes: int = Field(default=8 * 1024 * 1024, ge=1)

    # --- Detección ---
    detection_size: int = 640
    detection_threshold: float = 0.5
    # Tamaño mínimo (px) del rostro detectado para considerarlo "claro".
    min_face_size: int = 80

    # --- Matching (BR-I02) ---
    # Umbral coseno ArcFace. Default 0.40: medio de la franja OFICIAL de InsightFace para
    # buffalo_l/w600k_r50 (0.30–0.45 a FMR 1e-4/1e-5), lado conservador para un control de seguridad.
    # El valor previo 0.90 era empíricamente erróneo (rechazaba conductores legítimos: same-person
    # ArcFace ~0.3–0.45). Cambio aprobado tras la auditoría. La calibración FINA exige un validation set
    # etiquetado de la población real (recomputar EER/FMR). Configurable por VEO_BIO_MATCH_THRESHOLD.
    match_threshold: float = Field(default=0.40, ge=0.0, le=1.0)

    # Umbral coseno SEPARADO para el doc-match (DNI↔selfie, /v1/face-match), distinto del de turno
    # (selfie-vs-selfie, /v1/verify). El match doc-vs-selfie cae naturalmente más bajo: la foto del DNI es
    # vieja/baja-res/con holograma → la misma persona da coseno ~0.30–0.40, no el ~0.40–0.60 de un live
    # selfie-vs-selfie. Reusar 0.40 (umbral de turno) rechaza a la persona legítima. Default 0.30: borde
    # inferior de la franja oficial InsightFace (buffalo_l/w600k_r50). Configurable por
    # VEO_BIO_DOC_MATCH_THRESHOLD. NO toca el umbral de turno.
    # DEUDA: umbral doc-match 0.30 heuristica de dominio · techo: FMR no calibrado a poblacion real · gatillo: calibrar con validation set etiquetado (EER/FMR) antes de prod
    doc_match_threshold: float = Field(default=0.30, ge=0.0, le=1.0)

    # Consistencia de identidad intra-secuencia (anti-spoofing/splicing): el frame de match debe ser la
    # MISMA persona que hizo el gesto de liveness. Umbral coseno bajo (de la franja oficial 0.30–0.45):
    # intra-sesión la misma persona da coseno alto (>0.6), una persona distinta cae bajo (<0.3) → separa
    # limpio sin afectar al usuario legítimo. NO se calibra con el match (son problemas distintos).
    liveness_consistency_threshold: float = Field(default=0.35, ge=-1.0, le=1.0)
    # Tope de frames embebidos para match/consistencia (acota el costo de inferencia: p99 < 3s del SLA).
    max_match_frames: int = Field(default=8, ge=1)

    # --- Liveness activo (por reto) ---
    challenge_ttl_seconds: int = 60
    # Store de retos: vacío ⇒ in-memory (una réplica, dev). Con URL Redis ⇒ store distribuido
    # (multi-réplica: el HPA escala 2–10 pods y el reto debe ser visible/consumible en cualquiera).
    redis_url: str = ""
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
