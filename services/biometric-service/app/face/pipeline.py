"""Orquestador del pipeline biométrico REAL.

Une detector (SCRFD) + embedder (ArcFace) + liveness activo + matcher coseno y
produce una `Decision` del dominio. Carga los modelos ONNX desde MODEL_DIR.

La carga de modelos es perezosa y tolerante: si los modelos no están presentes,
`ready` es False y `/verify` responde 503 (degradado) salvo que `require_models`
fuerce el arranque estricto. La matemática de matching/liveness/decisión NO depende
de los modelos (está testeada de forma aislada).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional, Sequence

import numpy as np
import numpy.typing as npt

from app.config import Settings
from app.domain import Decision, DecisionInput, decide
from app.face.liveness import (
    ChallengeAction,
    FrameSignals,
    LivenessResult,
    LivenessThresholds,
    evaluate_liveness,
)
from app.face.matcher import to_vector

if TYPE_CHECKING:
    from app.face.detector import FaceDetection, ScrfdDetector
    from app.face.embedder import ArcFaceEmbedder

NDArrayF = npt.NDArray[np.float32]
NDArrayU8 = npt.NDArray[np.uint8]


@dataclass(frozen=True)
class PipelineOutput:
    """Salida del pipeline lista para mapear a la respuesta HTTP."""

    decision: Decision
    liveness: LivenessResult
    faces_in_primary_frame: int


def thresholds_from_settings(settings: Settings) -> LivenessThresholds:
    return LivenessThresholds(
        min_frames=settings.min_frames_for_liveness,
        yaw_turn_degrees=settings.yaw_turn_degrees,
        pitch_nod_degrees=settings.pitch_nod_degrees,
        blink_ear_threshold=settings.blink_ear_threshold,
        eye_open_ear_threshold=settings.eye_open_ear_threshold,
        smile_ratio_threshold=settings.smile_ratio_threshold,
        mouth_open_ratio_threshold=settings.mouth_open_ratio_threshold,
    )


class BiometricPipeline:
    """Pipeline con modelos ONNX cargados perezosamente desde MODEL_DIR."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._detector: Optional["ScrfdDetector"] = None
        self._embedder: Optional["ArcFaceEmbedder"] = None
        self._load_error: Optional[str] = None
        self._thresholds = thresholds_from_settings(settings)

    # --- carga de modelos ---
    def _detector_path(self) -> str:
        return os.path.join(self._settings.model_dir, self._settings.detector_model)

    def _embedder_path(self) -> str:
        return os.path.join(self._settings.model_dir, self._settings.embedder_model)

    def models_present(self) -> bool:
        return os.path.isfile(self._detector_path()) and os.path.isfile(self._embedder_path())

    def load(self) -> None:
        """Carga los modelos ONNX. Idempotente; registra error si falla."""
        if self._detector is not None and self._embedder is not None:
            return
        if not self.models_present():
            self._load_error = (
                f"Modelos ausentes en '{self._settings.model_dir}'. "
                "Ejecuta scripts/download_models.py."
            )
            if self._settings.require_models:
                raise RuntimeError(self._load_error)
            return
        from app.face.detector import load_detector
        from app.face.embedder import load_embedder

        self._detector = load_detector(self._settings, self._detector_path())
        self._embedder = load_embedder(self._settings, self._embedder_path())
        self._load_error = None

    @property
    def ready(self) -> bool:
        return self._detector is not None and self._embedder is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    # --- inferencia ---
    def _require_models(self) -> tuple["ScrfdDetector", "ArcFaceEmbedder"]:
        if self._detector is None or self._embedder is None:
            self.load()
        if self._detector is None or self._embedder is None:
            raise RuntimeError(self._load_error or "Modelos no cargados")
        return self._detector, self._embedder

    def extract_signals(self, frames_bgr: Sequence[NDArrayU8]) -> list[FrameSignals]:
        """Detecta el rostro en cada frame y deriva señales para liveness."""
        from app.face.detector import signals_from_keypoints

        detector, _ = self._require_models()
        signals: list[FrameSignals] = []
        for frame in frames_bgr:
            dets = detector.detect(frame)
            if not dets:
                signals.append(FrameSignals(face_count=0))
                continue
            primary = max(dets, key=lambda d: d.width * d.height)
            signals.append(
                signals_from_keypoints(primary, self._settings, face_count=len(dets))
            )
        return signals

    def best_detection(self, frame_bgr: NDArrayU8) -> tuple[int, Optional["FaceDetection"]]:
        """Devuelve (nº rostros, rostro principal) del frame de referencia."""
        detector, _ = self._require_models()
        dets = detector.detect(frame_bgr)
        if not dets:
            return 0, None
        primary = max(dets, key=lambda d: d.width * d.height)
        return len(dets), primary

    def embed(self, frame_bgr: NDArrayU8, detection: "FaceDetection") -> NDArrayF:
        _, embedder = self._require_models()
        return embedder.embed_face(frame_bgr, detection)

    def verify(
        self,
        *,
        action: ChallengeAction,
        challenge_valid: bool,
        frames_bgr: Sequence[NDArrayU8],
        reference_embedding: object,
    ) -> PipelineOutput:
        """Ejecuta el pipeline completo sobre los frames y la referencia.

        - Liveness sobre todos los frames.
        - Detección/embedding sobre el mejor frame (el último suele ser frontal-neutro;
          usamos el primer frame con un único rostro claro para el match).
        - Match coseno contra `reference_embedding`.
        """
        reference = to_vector(reference_embedding)

        if not challenge_valid:
            # No gastamos cómputo de modelos: la sesión no es confiable → BLOCKED.
            liveness = LivenessResult(
                passed=False, action=action, reason="reto inválido/vencido"
            )
            decision = decide(
                DecisionInput(
                    challenge_valid=False,
                    faces_detected=0,
                    liveness_passed=False,
                    match_score=0.0,
                    match_threshold=self._settings.match_threshold,
                )
            )
            return PipelineOutput(decision=decision, liveness=liveness, faces_in_primary_frame=0)

        signals = self.extract_signals(frames_bgr)
        liveness = evaluate_liveness(action, signals, self._thresholds)

        # Frame de match: el primero con exactamente un rostro claro.
        match_frame_idx = next(
            (i for i, s in enumerate(signals) if s.face_count == 1), None
        )
        faces_count = 0
        score = 0.0
        if match_frame_idx is not None:
            faces_count, detection = self.best_detection(frames_bgr[match_frame_idx])
            if detection is not None:
                probe = self.embed(frames_bgr[match_frame_idx], detection)
                from app.face.matcher import match_score

                score = match_score(probe, reference)

        decision = decide(
            DecisionInput(
                challenge_valid=True,
                faces_detected=faces_count,
                liveness_passed=liveness.passed,
                match_score=score,
                match_threshold=self._settings.match_threshold,
            )
        )
        return PipelineOutput(
            decision=decision, liveness=liveness, faces_in_primary_frame=faces_count
        )
