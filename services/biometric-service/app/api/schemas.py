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


class VerifyResponse(BaseModel):
    """Respuesta de POST /v1/verify."""

    result: VerificationResult
    score: float = Field(..., ge=0.0, le=1.0)
    liveness_passed: bool = Field(..., alias="livenessPassed")
    match_passed: bool = Field(..., alias="matchPassed")
    reason: str
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
    detail: Optional[str] = None

    model_config = {"populate_by_name": True}
