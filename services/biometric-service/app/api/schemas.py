"""Esquemas pydantic (contrato HTTP con identity-service)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, Field, model_validator

from app.domain import VerificationResult
from app.face.liveness import ChallengeAction


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Liveness challenge ---
class ChallengeResponse(BaseModel):
    """Respuesta de POST /v1/liveness/challenge."""

    challenge_id: str = Field(..., alias="challengeId")
    action: ChallengeAction
    instructions: str
    expires_at: str = Field(..., alias="expiresAt")

    model_config = {"populate_by_name": True}


# --- Verify ---
class VerifyRequest(BaseModel):
    """Cuerpo de POST /v1/verify (modo JSON/base64).

    Las imágenes se envían como base64 en `frames` (secuencia para liveness) y la
    referencia como `referenceEmbedding` (vector) o `referencePhoto` (base64).
    En modo multipart, los campos equivalentes se envían como form-data + ficheros.
    """

    driver_id: str = Field(..., alias="driverId", min_length=1)
    shift_id: Optional[str] = Field(default=None, alias="shiftId")
    challenge_id: str = Field(..., alias="challengeId", min_length=1)
    frames: List[str] = Field(default_factory=list, description="Frames en base64 (orden temporal)")
    reference_embedding: Optional[List[float]] = Field(default=None, alias="referenceEmbedding")
    reference_photo: Optional[str] = Field(default=None, alias="referencePhoto")

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _check_reference(self) -> "VerifyRequest":
        if self.reference_embedding is None and self.reference_photo is None:
            raise ValueError("Se requiere referenceEmbedding o referencePhoto")
        if not self.frames:
            raise ValueError("Se requiere al menos un frame")
        return self


class EmbedRequest(BaseModel):
    """Cuerpo de POST /v1/embed (enrolamiento): foto de referencia en base64."""

    photo: str = Field(..., min_length=1, description="Foto de referencia en base64")

    model_config = {"populate_by_name": True}


class EmbedResponse(BaseModel):
    """Respuesta de POST /v1/embed: embedding de referencia (ArcFace)."""

    embedding: List[float]
    dimensions: int


class EnrollPassiveResponse(BaseModel):
    """Respuesta de POST /v1/enroll-passive: enrolamiento del REGISTRO con liveness PASIVO (PAD single-frame).

    A diferencia de /v1/embed (1 foto sin liveness, para DNI/pasajero/server-to-server), acá se corre el PAD
    anti-spoofing sobre la MISMA foto ANTES de calcular el embedding:
      - `live=false` (spoof detectado) → `embedding=null`, `reason='spoof'` (NO se enrola un ataque de
        presentación; foto impresa/pantalla).
      - `live=true` → `embedding` presente (persona real).
    `livenessChecked=false` = el PAD no estaba cargado (modelo ausente) → degradación honesta: se enrola SIN
    liveness (comportamiento previo), `live=true` por defecto. El caller (identity) decide la política.
    """

    embedding: Optional[List[float]] = None
    dimensions: int = 0
    live: bool
    liveness_checked: bool = Field(..., alias="livenessChecked")
    spoof_score: float = Field(..., alias="spoofScore")
    reason: Optional[str] = None

    model_config = {"populate_by_name": True}


# --- Enroll con liveness (challenge-response) ---
class EnrollRequest(BaseModel):
    """Cuerpo de POST /v1/enroll: enrolamiento del rostro CON prueba de vida.

    A diferencia de /v1/embed (1 foto suelta, sin liveness), aquí el cliente envía la
    SECUENCIA de frames del reto challenge-response. El servidor exige que la secuencia
    supere el liveness del `challengeId` ANTES de calcular el embedding de referencia
    → el embedding enrolado proviene de una persona viva que hizo el gesto, no de una foto.
    Mismo contrato de frames que /v1/verify (base64, 1..max_frames, orden temporal).
    """

    driver_id: str = Field(..., alias="driverId", min_length=1)
    challenge_id: str = Field(..., alias="challengeId", min_length=1)
    frames: List[str] = Field(default_factory=list, description="Frames en base64 (orden temporal)")

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _check_frames(self) -> "EnrollRequest":
        if not self.frames:
            raise ValueError("Se requiere al menos un frame")
        return self


class EnrollResponse(BaseModel):
    """Respuesta de POST /v1/enroll.

    Si liveness PASS → `livenessPassed=true` y `embedding` con el vector 512-d del mejor
    frame (identity-service lo guarda como referencia del conductor). Si liveness FAIL →
    `livenessPassed=false`, `embedding=null` y `reason` con el motivo (NO se calcula embedding).
    """

    liveness_passed: bool = Field(..., alias="livenessPassed")
    embedding: Optional[List[float]] = None
    reason: Optional[str] = None
    taken_at: str = Field(default_factory=_utcnow_iso, alias="takenAt")

    model_config = {"populate_by_name": True}


class VerifyResponse(BaseModel):
    """Respuesta de POST /v1/verify."""

    result: VerificationResult
    score: float = Field(..., ge=0.0, le=1.0)
    liveness_passed: bool = Field(..., alias="livenessPassed")
    match_passed: bool = Field(..., alias="matchPassed")
    reason: str
    taken_at: str = Field(default_factory=_utcnow_iso, alias="takenAt")

    model_config = {"populate_by_name": True}


# --- Face match (rostro del DNI vs selfie enrolada) ---
class FaceMatchRequest(BaseModel):
    """Cuerpo de POST /v1/face-match.

    Compara el ROSTRO de una imagen (la foto del DNI, anverso) contra el embedding de
    referencia de la selfie enrolada. Cierra el hueco de seguridad: confirma que la
    persona enrolada ES la del documento. NO hay liveness (el DNI es una foto estática);
    el match coseno usa el umbral SEPARADO del doc-match (config doc_match_threshold, default
    0.30, más laxo que el de turno: el DNI es foto vieja/baja-res, BR-I02).
    """

    image: str = Field(..., min_length=1, description="Foto del DNI (anverso) en base64")
    reference_embedding: List[float] = Field(
        ...,
        alias="referenceEmbedding",
        min_length=1,
        description="Embedding 512-d de la selfie enrolada",
    )

    model_config = {"populate_by_name": True}


class FaceMatchResponse(BaseModel):
    """Respuesta de POST /v1/face-match.

    `matched` True solo si se aisló exactamente un rostro claro en el DNI y su similitud
    coseno contra la selfie enrolada alcanza el umbral. Si no hay rostro, hay varios, o el
    score no llega → `matched=false` y `reason` con el motivo (degradación honesta, nunca
    un PASS inventado). Cuando matchea, `reason` es None.
    """

    matched: bool
    score: float = Field(..., ge=0.0, le=1.0)
    reason: Optional[str] = None
    taken_at: str = Field(default_factory=_utcnow_iso, alias="takenAt")

    model_config = {"populate_by_name": True}


# --- Health ---
class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class ReadyResponse(BaseModel):
    ready: bool
    models_loaded: bool = Field(..., alias="modelsLoaded")
    # ¿El PAD anti-spoofing (liveness pasivo) está cargado? Expuesto aparte de `models_loaded` (detector+embedder)
    # para que ops/dashboards VEAN el modo degradado en vez de un pod "ready" engañoso. Con
    # `require_passive_liveness=True` (prod), `ready` es False si esto es False (fail-closed).
    passive_liveness_loaded: bool = Field(..., alias="passiveLivenessLoaded")
    detail: Optional[str] = None

    model_config = {"populate_by_name": True}
