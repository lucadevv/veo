"""Rutas HTTP del biometric-service (contrato con identity-service)."""
from __future__ import annotations

import random
import time
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import Response

from app import __version__
from app.api.schemas import (
    ChallengeResponse,
    EmbedRequest,
    EmbedResponse,
    HealthResponse,
    ReadyResponse,
    VerifyRequest,
    VerifyResponse,
)
from app.challenge_store import ChallengeStore
from app.config import Settings, get_settings
from app.face.imaging import decode_base64_image, decode_image_bytes
from app.face.liveness import CHALLENGE_INSTRUCTIONS, ChallengeAction
from app.face.pipeline import BiometricPipeline
from app.telemetry import (
    CHALLENGE_ISSUED_TOTAL,
    LIVENESS_TOTAL,
    MATCH_SCORE,
    VERIFY_LATENCY,
    VERIFY_TOTAL,
    metrics_payload,
)

router = APIRouter()


def get_pipeline(request: Request) -> BiometricPipeline:
    return request.app.state.pipeline  # type: ignore[no-any-return]


def get_store(request: Request) -> ChallengeStore:
    return request.app.state.challenge_store  # type: ignore[no-any-return]


# --- Health / readiness / metrics ---
@router.get("/health", response_model=HealthResponse, tags=["health"])
def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(status="ok", service=settings.service_name, version=__version__)


@router.get("/health/ready", tags=["health"])
def ready(
    response: Response,
    pipeline: BiometricPipeline = Depends(get_pipeline),
) -> ReadyResponse:
    pipeline.load()
    if not pipeline.ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(
        ready=pipeline.ready,
        modelsLoaded=pipeline.ready,
        detail=pipeline.load_error,
    )


@router.get("/metrics", tags=["observability"])
def metrics() -> Response:
    body, content_type = metrics_payload()
    return Response(content=body, media_type=content_type)


# --- Liveness challenge ---
@router.post(
    "/v1/liveness/challenge",
    response_model=ChallengeResponse,
    tags=["liveness"],
)
def create_challenge(
    settings: Settings = Depends(get_settings),
    store: ChallengeStore = Depends(get_store),
) -> ChallengeResponse:
    actions = [ChallengeAction(a) for a in settings.liveness_actions]
    action = random.choice(actions)
    challenge = store.issue(action)
    CHALLENGE_ISSUED_TOTAL.labels(action=action.value).inc()
    return ChallengeResponse(
        challengeId=challenge.challenge_id,
        action=action,
        instructions=CHALLENGE_INSTRUCTIONS[action],
        expiresAt=datetime.fromtimestamp(challenge.expires_at, tz=timezone.utc).isoformat(),
    )


# --- Embedding de referencia (enrolamiento) ---
@router.post("/v1/embed", response_model=EmbedResponse, tags=["enroll"])
def embed_reference(
    payload: EmbedRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
) -> EmbedResponse:
    """Calcula el embedding de referencia de una foto (enrolamiento).

    Reutiliza el detector + embedder del pipeline (best_detection + embed). Exige exactamente
    un rostro claro. identity-service guarda el embedding como referencia del conductor.
    """
    if not _ensure_models(pipeline):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=pipeline.load_error or "Modelos biométricos no disponibles",
        )
    try:
        image = decode_base64_image(payload.photo)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Foto inválida: {exc}") from exc
    count, detection = pipeline.best_detection(image)
    if count != 1 or detection is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La foto debe contener exactamente un rostro claro",
        )
    embedding: List[float] = pipeline.embed(image, detection).tolist()
    return EmbedResponse(embedding=embedding, dimensions=len(embedding))


def _resolve_reference(
    pipeline: BiometricPipeline,
    reference_embedding: Optional[List[float]],
    reference_photo: Optional[str],
) -> List[float]:
    """Devuelve el embedding de referencia (directo o calculado desde la foto)."""
    if reference_embedding is not None:
        return reference_embedding
    if reference_photo is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Se requiere referenceEmbedding o referencePhoto",
        )
    image = decode_base64_image(reference_photo)
    count, detection = pipeline.best_detection(image)
    if count != 1 or detection is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La foto de referencia debe contener exactamente un rostro claro",
        )
    embedding: List[float] = pipeline.embed(image, detection).tolist()
    return embedding


def _run_verify(
    *,
    pipeline: BiometricPipeline,
    store: ChallengeStore,
    challenge_id: str,
    frames_bgr: list,  # type: ignore[type-arg]
    reference_embedding: List[float],
) -> VerifyResponse:
    started = time.perf_counter()
    challenge = store.consume(challenge_id)
    action = challenge.action if challenge is not None else ChallengeAction.TURN_LEFT
    out = pipeline.verify(
        action=action,
        challenge_valid=challenge is not None,
        frames_bgr=frames_bgr,
        reference_embedding=reference_embedding,
    )
    decision = out.decision
    VERIFY_TOTAL.labels(result=decision.result.value).inc()
    LIVENESS_TOTAL.labels(passed=str(out.liveness.passed).lower()).inc()
    MATCH_SCORE.observe(decision.score)
    VERIFY_LATENCY.observe(time.perf_counter() - started)
    return VerifyResponse(
        result=decision.result,
        score=round(decision.score, 6),
        livenessPassed=decision.liveness_passed,
        matchPassed=decision.match_passed,
        reason=decision.reason,
    )


@router.post("/v1/verify", response_model=VerifyResponse, tags=["verify"])
def verify_json(
    payload: VerifyRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    store: ChallengeStore = Depends(get_store),
) -> VerifyResponse:
    """Verificación en modo JSON/base64."""
    if not _ensure_models(pipeline):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=pipeline.load_error or "Modelos biométricos no disponibles",
        )
    try:
        frames = [decode_base64_image(f) for f in payload.frames]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Frame inválido: {exc}") from exc
    reference = _resolve_reference(pipeline, payload.reference_embedding, payload.reference_photo)
    return _run_verify(
        pipeline=pipeline,
        store=store,
        challenge_id=payload.challenge_id,
        frames_bgr=frames,
        reference_embedding=reference,
    )


@router.post("/v1/verify/multipart", response_model=VerifyResponse, tags=["verify"])
async def verify_multipart(
    driver_id: str = Form(..., alias="driverId"),
    challenge_id: str = Form(..., alias="challengeId"),
    shift_id: Optional[str] = Form(default=None, alias="shiftId"),
    frames: List[UploadFile] = File(...),
    reference_photo: Optional[UploadFile] = File(default=None),
    pipeline: BiometricPipeline = Depends(get_pipeline),
    store: ChallengeStore = Depends(get_store),
) -> VerifyResponse:
    """Verificación en modo multipart (ficheros de imagen)."""
    if not _ensure_models(pipeline):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=pipeline.load_error or "Modelos biométricos no disponibles",
        )
    if not frames:
        raise HTTPException(status_code=422, detail="Se requiere al menos un frame")
    try:
        frame_imgs = [decode_image_bytes(await f.read()) for f in frames]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Frame inválido: {exc}") from exc

    if reference_photo is None:
        raise HTTPException(
            status_code=422,
            detail="Se requiere referencePhoto (en multipart) o usa el endpoint JSON con referenceEmbedding",
        )
    ref_img = decode_image_bytes(await reference_photo.read())
    count, detection = pipeline.best_detection(ref_img)
    if count != 1 or detection is None:
        raise HTTPException(
            status_code=422,
            detail="La foto de referencia debe contener exactamente un rostro claro",
        )
    reference = pipeline.embed(ref_img, detection).tolist()
    return _run_verify(
        pipeline=pipeline,
        store=store,
        challenge_id=challenge_id,
        frames_bgr=frame_imgs,
        reference_embedding=reference,
    )


def _ensure_models(pipeline: BiometricPipeline) -> bool:
    if not pipeline.ready:
        pipeline.load()
    return pipeline.ready
