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
import threading
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
    from app.face.spoof import AntiSpoofClassifier, SpoofVerdict

NDArrayF = npt.NDArray[np.float32]
NDArrayU8 = npt.NDArray[np.uint8]


@dataclass(frozen=True)
class PipelineOutput:
    """Salida del pipeline lista para mapear a la respuesta HTTP."""

    decision: Decision
    liveness: LivenessResult
    faces_in_primary_frame: int


@dataclass(frozen=True)
class EnrollOutput:
    """Salida del enrolamiento con liveness (POST /v1/enroll).

    Si `liveness.passed` es True, `embedding` trae el vector 512-d del mejor frame; si es
    False, `embedding` es None (no se gasta cómputo de embedding sobre una sesión no viva).
    """

    liveness: LivenessResult
    embedding: Optional[NDArrayF]
    best_frame_index: Optional[int]


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
        # PAD pasivo (anti-spoofing single-frame). OPCIONAL: si falta el modelo, el enroll degrada a "solo
        # detección de rostro" sin liveness. NO entra en `ready` (det+embed), que gobierna /verify.
        self._anti_spoof: Optional["AntiSpoofClassifier"] = None
        self._load_error: Optional[str] = None
        self._thresholds = thresholds_from_settings(settings)
        # Serializa la carga de modelos: FastAPI sirve los endpoints sync en un threadpool, así que
        # dos requests en frío podrían construir DOS InferenceSession a la vez (pico de RAM + race).
        self._load_lock = threading.Lock()

    # --- carga de modelos ---
    def _detector_path(self) -> str:
        return os.path.join(self._settings.model_dir, self._settings.detector_model)

    def _embedder_path(self) -> str:
        return os.path.join(self._settings.model_dir, self._settings.embedder_model)

    def _spoof_path(self) -> str:
        return os.path.join(self._settings.model_dir, self._settings.spoof_model)

    def models_present(self) -> bool:
        return os.path.isfile(self._detector_path()) and os.path.isfile(self._embedder_path())

    def load(self) -> None:
        """Carga los modelos ONNX. Idempotente y thread-safe; registra error si falla."""
        # Fast-path sin lock: una vez cargado, no se paga contención.
        if self._detector is not None and self._embedder is not None:
            return
        with self._load_lock:
            # Re-chequeo dentro del lock: otro thread pudo cargar mientras esperábamos.
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
            # PAD pasivo (OPCIONAL, best-effort): si está habilitado y el modelo está presente, lo cargamos.
            # Si falta o falla, queda en None → `classify_liveness` degrada honesto (sin liveness pasivo), sin
            # tumbar el servicio ni afectar `ready`.
            if self._settings.passive_liveness_enabled and os.path.isfile(self._spoof_path()):
                try:
                    from app.face.spoof import load_anti_spoof

                    self._anti_spoof = load_anti_spoof(self._settings, self._spoof_path())
                except Exception:  # noqa: BLE001 — degradación honesta: el PAD es opcional
                    self._anti_spoof = None

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

    @property
    def passive_liveness_loaded(self) -> bool:
        """¿El PAD pasivo está cargado? (para observabilidad / health: si False, el enroll no exige liveness)."""
        return self._anti_spoof is not None

    def classify_liveness(
        self, image_bgr: NDArrayU8, detection: "FaceDetection"
    ) -> Optional["SpoofVerdict"]:
        """Veredicto de vida PASIVO (PAD) sobre el rostro detectado. `None` si el PAD no está cargado/
        habilitado → degradación honesta (el caller decide exigir liveness o aceptar el enroll sin él)."""
        if self._anti_spoof is None:
            return None
        return self._anti_spoof.classify(image_bgr, detection)

    def _passive_liveness(
        self,
        action: ChallengeAction,
        signals: Sequence[FrameSignals],
        frames_bgr: Sequence[NDArrayU8],
    ) -> LivenessResult:
        """Prueba de vida PASIVA del gate de turno: corre el PAD (MiniFASNet) sobre el MEJOR frame con un
        rostro claro, en vez del reto geométrico (sonreír/girar). Es el MISMO motor que el enroll del
        registro (`classify_liveness`). Sin PAD cargado → degradación HONESTA: no bloquea el turno (el match
        ArcFace sigue gateando la identidad); el estado degradado es visible en /health/ready."""
        valid_idxs = [i for i, s in enumerate(signals) if s.face_count == 1]
        if not valid_idxs:
            return LivenessResult(
                passed=False, action=action, reason="sin rostro claro para la prueba de vida"
            )
        best_idx = max(valid_idxs, key=lambda i: self._frame_quality(frames_bgr[i], signals[i]))
        count, detection = self.best_detection(frames_bgr[best_idx])
        if count != 1 or detection is None:
            return LivenessResult(
                passed=False, action=action, reason="no se aisló un rostro claro para la prueba de vida"
            )
        verdict = self.classify_liveness(frames_bgr[best_idx], detection)
        if verdict is None:
            return LivenessResult(
                passed=True, action=action, reason="prueba de vida pasiva no disponible (degradado)"
            )
        return LivenessResult(
            passed=verdict.live,
            action=action,
            reason="ok" if verdict.live else "posible suplantación (foto o pantalla)",
            detail={"spoof_score": verdict.score},
        )

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
        - Binding anti-spoofing: el match se ata a la identidad que hizo el gesto. Embebemos los frames
          con un único rostro y exigimos que TODOS sean la misma persona (consistencia intra-secuencia);
          el probe es esa identidad (anchor), no "cualquier frame con una cara".
        - Match coseno del anchor contra `reference_embedding`.
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
        # Gate de turno: liveness PASIVO (PAD single-frame) por default — decisión del dueño, coherente con el
        # enroll del registro — o ACTIVO (reto geométrico) según `verify_liveness_mode`. El binding/match de
        # abajo (embed + consistencia intra-secuencia + coseno) NO cambia entre modos.
        liveness = (
            self._passive_liveness(action, signals, frames_bgr)
            if self._settings.verify_liveness_mode == "passive"
            else evaluate_liveness(action, signals, self._thresholds)
        )

        # Frames con un único rostro claro (hasta max_match_frames para acotar el costo de inferencia).
        valid_idxs = [i for i, s in enumerate(signals) if s.face_count == 1][
            : self._settings.max_match_frames
        ]
        embeddings = [
            self.embed(frames_bgr[i], det)
            for i in valid_idxs
            if (det := self.best_detection(frames_bgr[i])[1]) is not None
        ]

        faces_count = 0
        score = 0.0
        identity_consistent = True
        if embeddings:
            from app.face.matcher import cosine_similarity, match_score

            faces_count = 1
            # anchor = identidad del que hizo el gesto; el match se ata a ÉL, no a un frame cualquiera.
            anchor = embeddings[0]
            identity_consistent = all(
                cosine_similarity(anchor, other) >= self._settings.liveness_consistency_threshold
                for other in embeddings[1:]
            )
            score = match_score(anchor, reference)

        decision = decide(
            DecisionInput(
                challenge_valid=True,
                faces_detected=faces_count,
                liveness_passed=liveness.passed,
                match_score=score,
                match_threshold=self._settings.match_threshold,
                identity_consistent=identity_consistent,
            )
        )
        return PipelineOutput(
            decision=decision, liveness=liveness, faces_in_primary_frame=faces_count
        )

    def _frame_quality(self, frame_bgr: NDArrayU8, signal: FrameSignals) -> float:
        """Puntúa la calidad de un frame para elegir el "mejor" del enrolamiento.

        Combina (mayor = mejor):
          - frontalidad: penaliza yaw/pitch fuera del eje (el gesto de liveness mueve la cabeza;
            para la FOTO de referencia queremos el frame más frontal, no el del extremo del giro);
          - confianza de detección del SCRFD;
          - nitidez: varianza del Laplaciano (un frame borroso o movido da varianza baja).
        Es una heurística de selección, NO un umbral de seguridad: no decide PASS/FAIL.
        """
        import cv2  # carga perezosa

        frontality = -(abs(signal.yaw_deg) + abs(signal.pitch_deg))
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        # Escalas: frontality en grados (~0..-180), sharpness en cientos. Normalizamos sharpness
        # para que no domine y mantenga frontalidad/confianza como criterios de primer orden.
        return frontality + signal.detection_confidence * 50.0 + min(sharpness, 500.0) / 10.0

    def enroll(
        self,
        *,
        action: ChallengeAction,
        challenge_valid: bool,
        frames_bgr: Sequence[NDArrayU8],
    ) -> EnrollOutput:
        """Enrolamiento del rostro CON prueba de vida (challenge-response).

        Reusa el MISMO motor que `verify`:
          - `extract_signals` (detección SCRFD por frame) + `evaluate_liveness` (mismo `_thresholds`)
            para la prueba de vida contra `action`.
          - `best_detection` + `embed` (ArcFace) para el embedding de referencia.

        Si el reto es inválido/vencido o el liveness no pasa → embedding None (no se calcula).
        Si pasa → se elige el frame más frontal/nítido con un único rostro y se devuelve su embedding.
        """
        if not challenge_valid:
            liveness = LivenessResult(
                passed=False, action=action, reason="reto inválido/vencido"
            )
            return EnrollOutput(liveness=liveness, embedding=None, best_frame_index=None)

        signals = self.extract_signals(frames_bgr)
        liveness = evaluate_liveness(action, signals, self._thresholds)
        if not liveness.passed:
            # Liveness FAIL → NO calculamos embedding (no gastamos inferencia sobre sesión no viva).
            return EnrollOutput(liveness=liveness, embedding=None, best_frame_index=None)

        # Liveness PASS: elegimos el MEJOR frame entre los que tienen exactamente un rostro claro.
        valid_idxs = [i for i, s in enumerate(signals) if s.face_count == 1]
        if not valid_idxs:
            # Defensa: evaluate_liveness ya exige min_frames con un rostro, pero si por la
            # configuración de umbrales pasara sin frames válidos, degradamos honesto.
            failed = LivenessResult(
                passed=False,
                action=action,
                reason="sin frames con un rostro claro para enrolar",
                detail=liveness.detail,
            )
            return EnrollOutput(liveness=failed, embedding=None, best_frame_index=None)

        best_idx = max(valid_idxs, key=lambda i: self._frame_quality(frames_bgr[i], signals[i]))
        count, detection = self.best_detection(frames_bgr[best_idx])
        if count != 1 or detection is None:
            # El re-chequeo del detector no encontró exactamente un rostro en el frame elegido
            # (carrera improbable entre extract_signals y best_detection): degradamos honesto.
            failed = LivenessResult(
                passed=False,
                action=action,
                reason="no se pudo aislar un rostro claro en el mejor frame",
                detail=liveness.detail,
            )
            return EnrollOutput(liveness=failed, embedding=None, best_frame_index=None)

        embedding = self.embed(frames_bgr[best_idx], detection)
        return EnrollOutput(liveness=liveness, embedding=embedding, best_frame_index=best_idx)
