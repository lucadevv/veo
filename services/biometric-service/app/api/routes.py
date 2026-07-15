"""Rutas HTTP del biometric-service (contrato con identity-service)."""
from __future__ import annotations

import logging
import random
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app import __version__
from app.api.schemas import (
    ChallengeResponse,
    EmbedRequest,
    EmbedResponse,
    EnrollPassiveResponse,
    EnrollRequest,
    EnrollResponse,
    FaceMatchRequest,
    FaceMatchResponse,
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
from app.security.internal_identity import require_internal_identity
from app.telemetry import (
    CHALLENGE_ISSUED_TOTAL,
    ENROLL_PASSIVE_TOTAL,
    FACE_MATCH_LATENCY,
    FACE_MATCH_TOTAL,
    LIVENESS_TOTAL,
    MATCH_SCORE,
    SPOOF_SCORE,
    VERIFY_LATENCY,
    VERIFY_TOTAL,
    metrics_payload,
)

router = APIRouter()
logger = logging.getLogger("biometric")


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
    settings: Settings = Depends(get_settings),
) -> ReadyResponse:
    pipeline.load()
    pad_loaded = pipeline.passive_liveness_loaded
    # Readiness HONESTO: refleja detector+embedder (`pipeline.ready`) Y el PAD anti-spoofing. Fail-closed en
    # prod (`require_passive_liveness`): un pod sin PAD NO se reporta listo → no entra al balanceador → el
    # registro nunca enrola sin anti-spoofing. En dev (require=False) queda listo igual, pero el flag
    # `passiveLivenessLoaded` deja el modo degradado VISIBLE (no más "ready" engañoso).
    ready_ok = pipeline.ready and (pad_loaded or not settings.require_passive_liveness)
    if not ready_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(
        ready=ready_ok,
        modelsLoaded=pipeline.ready,
        passiveLivenessLoaded=pad_loaded,
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
    dependencies=[Depends(require_internal_identity)],
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


def _ensure_models(pipeline: BiometricPipeline) -> bool:
    if not pipeline.ready:
        pipeline.load()
    return pipeline.ready


def _require_models_ready(pipeline: BiometricPipeline) -> None:
    """503 si los modelos no están cargados (modo degradado)."""
    if not _ensure_models(pipeline):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=pipeline.load_error or "Modelos biométricos no disponibles",
        )


@contextmanager
def _domain_errors_as_422() -> Iterator[None]:
    """Traduce ValueError del dominio (embedding mal formado, dim incompatible, sin transformación
    afín, norma ~0…) a HTTP 422. Sin esto, un referenceEmbedding inválido (dim≠512/NaN/vacío) que
    pydantic acepta explota como 500 dentro del pipeline."""
    try:
        yield
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Entrada inválida: {exc}") from exc


def _check_frame_count(n: int, settings: Settings) -> None:
    """Anti-DoS: corta amplificación de cómputo por exceso de frames."""
    if n < 1:
        raise HTTPException(status_code=422, detail="Se requiere al menos un frame")
    if n > settings.max_frames:
        raise HTTPException(
            status_code=422,
            detail=f"Demasiados frames: {n} (máximo {settings.max_frames})",
        )


def _check_image_bytes(data: bytes, settings: Settings) -> None:
    """Anti-DoS / decompression-bomb: tope de bytes por imagen recibida."""
    if len(data) > settings.max_image_bytes:
        raise HTTPException(
            status_code=422,
            detail=f"Imagen demasiado grande: {len(data)} bytes (máximo {settings.max_image_bytes})",
        )


def _check_b64_image_size(b64: str, settings: Settings) -> None:
    """Estima los bytes decodificados de un base64 (~3/4 del largo) y aplica el tope ANTES de decodificar."""
    approx_bytes = (len(b64) * 3) // 4
    if approx_bytes > settings.max_image_bytes:
        raise HTTPException(
            status_code=422,
            detail=f"Imagen demasiado grande: ~{approx_bytes} bytes (máximo {settings.max_image_bytes})",
        )


def _embed_single_face(pipeline: BiometricPipeline, image: object) -> List[float]:
    """Detecta EXACTAMENTE un rostro claro y devuelve su embedding 512-d. 422 si hay 0 o 2+ rostros.

    Único punto de verdad del enrolamiento (antes triplicado en embed / referencia JSON / multipart).
    """
    count, detection = pipeline.best_detection(image)
    if count != 1 or detection is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La imagen debe contener exactamente un rostro claro",
        )
    return pipeline.embed(image, detection).tolist()


# --- Embedding de referencia (enrolamiento) ---
@router.post(
    "/v1/embed",
    response_model=EmbedResponse,
    tags=["enroll"],
    dependencies=[Depends(require_internal_identity)],
)
def embed_reference(
    payload: EmbedRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings),
) -> EmbedResponse:
    """Calcula el embedding de referencia de una foto (enrolamiento).

    Exige exactamente un rostro claro. identity-service guarda el embedding como referencia del conductor.
    Endpoint sync (`def`): FastAPI lo corre en el threadpool, así la inferencia ONNX no bloquea el event loop.
    """
    _require_models_ready(pipeline)
    _check_b64_image_size(payload.photo, settings)
    try:
        image = decode_base64_image(payload.photo)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Foto inválida: {exc}") from exc
    embedding = _embed_single_face(pipeline, image)
    return EmbedResponse(embedding=embedding, dimensions=len(embedding))


# --- Enroll del REGISTRO con liveness PASIVO (PAD single-frame, anti-spoofing) ---
@router.post(
    "/v1/enroll-passive",
    response_model=EnrollPassiveResponse,
    tags=["enroll"],
    dependencies=[Depends(require_internal_identity)],
)
def enroll_passive(
    payload: EmbedRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings),
) -> EnrollPassiveResponse:
    """Enrolamiento del REGISTRO del conductor: liveness PASIVO sobre 1 foto + embedding (SIN frames extra).

    Corre el PAD anti-spoofing ANTES del embedding: si la foto es un ataque de presentación (impresa/pantalla)
    → NO se enrola (embedding null, reason 'spoof'). Si es persona real → embedding. Si el PAD no está cargado
    → degrada honesto a enrolar SIN liveness (`livenessChecked=false`). El `/v1/embed` genérico (DNI/pasajero)
    NO pasa por acá: el PAD solo aplica a la selfie del registro. Sync (`def`): corre en el threadpool.
    """
    _require_models_ready(pipeline)
    _check_b64_image_size(payload.photo, settings)
    try:
        image = decode_base64_image(payload.photo)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Foto inválida: {exc}") from exc
    count, detection = pipeline.best_detection(image)
    if count != 1 or detection is None:
        ENROLL_PASSIVE_TOTAL.labels(result="no_face").inc()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La imagen debe contener exactamente un rostro claro",
        )
    verdict = pipeline.classify_liveness(image, detection)
    if verdict is not None and not verdict.live:
        # Spoof detectado: NO se enrola (no se gasta embedding sobre un ataque de presentación).
        ENROLL_PASSIVE_TOTAL.labels(result="spoof").inc()
        SPOOF_SCORE.observe(verdict.score)
        return EnrollPassiveResponse(
            embedding=None,
            dimensions=0,
            live=False,
            liveness_checked=True,
            spoof_score=verdict.score,
            reason="spoof",
        )
    embedding = pipeline.embed(image, detection).tolist()
    # `degraded` = el PAD no corrió (modelo ausente) → enrolado SIN liveness. Etiqueta DISTINTA de `enrolled`
    # para que el dashboard distinga el modo degradado (gap "PAD off en prod") de un enrol con anti-spoofing real.
    ENROLL_PASSIVE_TOTAL.labels(result="enrolled" if verdict is not None else "degraded").inc()
    if verdict is not None:
        SPOOF_SCORE.observe(verdict.score)
    return EnrollPassiveResponse(
        embedding=embedding,
        dimensions=len(embedding),
        live=True,
        liveness_checked=verdict is not None,
        spoof_score=0.0 if verdict is None else verdict.score,
        reason=None,
    )


@router.post(
    "/v1/enroll",
    response_model=EnrollResponse,
    response_model_exclude_none=False,
    tags=["enroll"],
    dependencies=[Depends(require_internal_identity)],
)
def enroll_with_liveness(
    payload: EnrollRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    store: ChallengeStore = Depends(get_store),
    settings: Settings = Depends(get_settings),
) -> EnrollResponse:
    """Enrolamiento del rostro CON prueba de vida (challenge-response).

    A diferencia de /v1/embed (1 foto suelta, sin liveness), exige que la secuencia de frames
    supere el reto de liveness del `challengeId` ANTES de calcular el embedding de referencia.
    Reusa el MISMO motor que /v1/verify: store.consume (anti-replay one-shot), extract_signals +
    evaluate_liveness, y best_detection + embed (ArcFace). Endpoint sync (`def`) → threadpool de
    FastAPI, así la inferencia ONNX (CPU-bound) no bloquea el event loop.

    Caminos infelices (sin crashear):
      - challenge inválido/vencido → livenessPassed=false, embedding=null, reason="Reto ...".
      - liveness no superado / sin rostro → livenessPassed=false, embedding=null, reason=<motivo>.
      - frames mal formados o demasiados/grandes → 422 (mismo gate anti-DoS que /v1/verify).
    """
    _require_models_ready(pipeline)
    _check_frame_count(len(payload.frames), settings)
    for f in payload.frames:
        _check_b64_image_size(f, settings)
    try:
        frames = [decode_base64_image(f) for f in payload.frames]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Frame inválido: {exc}") from exc

    # One-shot: consumimos el reto (anti-replay), igual que /v1/verify.
    challenge = store.consume(payload.challenge_id)
    action = challenge.action if challenge is not None else ChallengeAction.TURN_LEFT

    with _domain_errors_as_422():
        out = pipeline.enroll(
            action=action,
            challenge_valid=challenge is not None,
            frames_bgr=frames,
        )

    LIVENESS_TOTAL.labels(passed=str(out.liveness.passed).lower()).inc()
    embedding = out.embedding.tolist() if out.embedding is not None else None
    # Audit trail (Ley 29733): atribuye el enrolamiento al conductor. SIN PII biométrica
    # (nunca el embedding ni imágenes), solo el ID + veredicto de liveness.
    logger.info(
        "biometric.enroll",
        extra={
            "driverId": payload.driver_id,
            "livenessPassed": out.liveness.passed,
            "reason": out.liveness.reason,
        },
    )
    return EnrollResponse(
        livenessPassed=out.liveness.passed,
        embedding=embedding,
        reason=None if out.liveness.passed else out.liveness.reason,
    )


def _resolve_reference(
    pipeline: BiometricPipeline,
    reference_embedding: Optional[List[float]],
    reference_photo: Optional[str],
) -> List[float]:
    """Devuelve el embedding de referencia (directo del caller o calculado desde la foto)."""
    if reference_embedding is not None:
        return reference_embedding
    if reference_photo is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Se requiere referenceEmbedding o referencePhoto",
        )
    image = decode_base64_image(reference_photo)
    return _embed_single_face(pipeline, image)


def _run_verify(
    *,
    pipeline: BiometricPipeline,
    store: ChallengeStore,
    challenge_id: str,
    driver_id: str,
    shift_id: Optional[str],
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
    # Audit trail (Ley 29733): atribuye la verificación al conductor/turno. SIN PII biométrica
    # (nunca embeddings ni imágenes), solo IDs + veredicto. driverId/shiftId antes se descartaban.
    logger.info(
        "biometric.verify",
        extra={
            "driverId": driver_id,
            "shiftId": shift_id,
            "result": decision.result.value,
            "score": round(decision.score, 6),
            "livenessPassed": decision.liveness_passed,
            "matchPassed": decision.match_passed,
        },
    )
    return VerifyResponse(
        result=decision.result,
        score=round(decision.score, 6),
        livenessPassed=decision.liveness_passed,
        matchPassed=decision.match_passed,
        reason=decision.reason,
    )


@router.post(
    "/v1/verify",
    response_model=VerifyResponse,
    tags=["verify"],
    dependencies=[Depends(require_internal_identity)],
)
def verify_json(
    payload: VerifyRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    store: ChallengeStore = Depends(get_store),
    settings: Settings = Depends(get_settings),
) -> VerifyResponse:
    """Verificación en modo JSON/base64. Endpoint sync (`def`) → corre en el threadpool de FastAPI,
    así la inferencia ONNX (CPU-bound) no bloquea el event loop."""
    _require_models_ready(pipeline)
    _check_frame_count(len(payload.frames), settings)
    for f in payload.frames:
        _check_b64_image_size(f, settings)
    try:
        frames = [decode_base64_image(f) for f in payload.frames]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Frame inválido: {exc}") from exc
    with _domain_errors_as_422():
        reference = _resolve_reference(pipeline, payload.reference_embedding, payload.reference_photo)
        return _run_verify(
            pipeline=pipeline,
            store=store,
            challenge_id=payload.challenge_id,
            driver_id=payload.driver_id,
            shift_id=payload.shift_id,
            frames_bgr=frames,
            reference_embedding=reference,
        )


@router.post(
    "/v1/face-match",
    response_model=FaceMatchResponse,
    tags=["verify"],
    dependencies=[Depends(require_internal_identity)],
)
def face_match(
    payload: FaceMatchRequest,
    pipeline: BiometricPipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings),
) -> FaceMatchResponse:
    """Compara el ROSTRO de la foto del DNI contra el embedding de la selfie enrolada.

    Cierra el hueco de seguridad: confirma que la persona enrolada ES la del documento.
    NO hay liveness (el DNI es una foto estática); reusa el MISMO motor que /v1/verify:
    decode (EXIF) → SCRFD (best_detection, exige 1 rostro claro) → ArcFace (embed) →
    match coseno (match_score) contra `referenceEmbedding` con el umbral SEPARADO del doc-match
    (settings.doc_match_threshold, default 0.30, NO el de turno match_threshold). El DNI es foto
    vieja/baja-res → la misma persona cae más bajo que un live selfie-vs-selfie. Endpoint sync
    (`def`) → threadpool de FastAPI, así la inferencia ONNX (CPU-bound) no bloquea el event loop.

    Degradación honesta (nunca un PASS inventado):
      - modelos ausentes → 503.
      - imagen mal formada / base64 inválido / demasiado grande → 422.
      - referenceEmbedding mal formado (dim≠512/NaN/vacío) → 422.
      - rostro del DNI no detectable o varios rostros → matched=false + reason explícito.
    """
    _require_models_ready(pipeline)
    _check_b64_image_size(payload.image, settings)
    try:
        image = decode_base64_image(payload.image)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Imagen inválida: {exc}") from exc

    from app.face.matcher import match_score, to_vector

    started = time.perf_counter()
    with _domain_errors_as_422():
        # Valida el embedding de referencia ANTES de gastar inferencia (dim/NaN/vacío → 422).
        reference = to_vector(payload.reference_embedding)
        count, detection = pipeline.best_detection(image)

    if count != 1 or detection is None:
        # Sin rostro o varios en el DNI: degradación honesta, NUNCA un match inventado.
        reason = (
            "No se detectó un rostro en la imagen del DNI"
            if count == 0
            else f"Se detectaron {count} rostros en la imagen del DNI (se requiere exactamente uno)"
        )
        FACE_MATCH_TOTAL.labels(matched="false").inc()
        FACE_MATCH_LATENCY.observe(time.perf_counter() - started)
        logger.info("biometric.face_match", extra={"matched": False, "reason": reason})
        return FaceMatchResponse(matched=False, score=0.0, reason=reason)

    with _domain_errors_as_422():
        probe = pipeline.embed(image, detection)
        # Mismo motor de match que /v1/verify: similitud coseno mapeada a [0,1].
        score = match_score(probe, reference)

    # Doc-match usa su PROPIO umbral (settings.doc_match_threshold, default 0.30), NO el de turno
    # (match_threshold, 0.40). El DNI es foto vieja/baja-res → la misma persona cae más bajo; el umbral
    # de turno la rechazaría. Ver config.py:doc_match_threshold.
    threshold = settings.doc_match_threshold
    matched = score >= threshold
    reason = None if matched else f"Similitud {score:.4f} por debajo del umbral {threshold:.2f}"

    FACE_MATCH_TOTAL.labels(matched=str(matched).lower()).inc()
    MATCH_SCORE.observe(score)
    FACE_MATCH_LATENCY.observe(time.perf_counter() - started)
    # Audit trail (Ley 29733): SIN PII biométrica (nunca embeddings ni imágenes), solo veredicto.
    logger.info(
        "biometric.face_match",
        extra={"matched": matched, "score": round(score, 6)},
    )
    return FaceMatchResponse(
        matched=matched,
        score=round(score, 6),
        reason=reason,
    )


def _process_multipart_verify(
    *,
    pipeline: BiometricPipeline,
    store: ChallengeStore,
    challenge_id: str,
    driver_id: str,
    shift_id: Optional[str],
    frame_bytes: List[bytes],
    reference_bytes: bytes,
) -> VerifyResponse:
    """Trabajo CPU-bound del multipart (decode + detección + embed + verify). Se corre en el threadpool
    para NO bloquear el event loop (el handler es async por la lectura de los UploadFile)."""
    try:
        frame_imgs = [decode_image_bytes(b) for b in frame_bytes]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Frame inválido: {exc}") from exc
    with _domain_errors_as_422():
        ref_img = decode_image_bytes(reference_bytes)
        reference = _embed_single_face(pipeline, ref_img)
        return _run_verify(
            pipeline=pipeline,
            store=store,
            challenge_id=challenge_id,
            driver_id=driver_id,
            shift_id=shift_id,
            frames_bgr=frame_imgs,
            reference_embedding=reference,
        )


@router.post(
    "/v1/verify/multipart",
    response_model=VerifyResponse,
    tags=["verify"],
    dependencies=[Depends(require_internal_identity)],
)
async def verify_multipart(
    driver_id: str = Form(..., alias="driverId"),
    challenge_id: str = Form(..., alias="challengeId"),
    shift_id: Optional[str] = Form(default=None, alias="shiftId"),
    frames: List[UploadFile] = File(...),
    reference_photo: Optional[UploadFile] = File(default=None),
    pipeline: BiometricPipeline = Depends(get_pipeline),
    store: ChallengeStore = Depends(get_store),
    settings: Settings = Depends(get_settings),
) -> VerifyResponse:
    """Verificación en modo multipart (ficheros). El handler es `async` SOLO para leer los UploadFile;
    la inferencia se delega al threadpool (`run_in_threadpool`) para no bloquear el event loop."""
    _require_models_ready(pipeline)
    _check_frame_count(len(frames), settings)
    if reference_photo is None:
        raise HTTPException(
            status_code=422,
            detail="Se requiere referencePhoto (en multipart) o usa el endpoint JSON con referenceEmbedding",
        )
    frame_bytes: List[bytes] = []
    for f in frames:
        data = await f.read()
        _check_image_bytes(data, settings)
        frame_bytes.append(data)
    reference_bytes = await reference_photo.read()
    _check_image_bytes(reference_bytes, settings)

    return await run_in_threadpool(
        _process_multipart_verify,
        pipeline=pipeline,
        store=store,
        challenge_id=challenge_id,
        driver_id=driver_id,
        shift_id=shift_id,
        frame_bytes=frame_bytes,
        reference_bytes=reference_bytes,
    )
