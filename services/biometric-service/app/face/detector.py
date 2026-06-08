"""Detector facial SCRFD (ONNX) — detección REAL de rostros + 5 landmarks.

Implementa el decodificado de anchors de SCRFD (strides 8/16/32, score+bbox+kps)
y NMS, idéntico al pipeline de InsightFace. A partir de los 5 keypoints estima
señales geométricas de pose/expresión (`FrameSignals`) para el liveness activo.

Imports pesados (onnxruntime, cv2) se cargan de forma perezosa para que la lógica
pura (matcher/liveness/dominio) y sus tests no requieran estas dependencias.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
import numpy.typing as npt

from app.config import Settings
from app.face.liveness import FrameSignals

if TYPE_CHECKING:  # solo para type-checkers; no se importa en runtime ligero.
    import onnxruntime as ort

NDArrayF = npt.NDArray[np.float32]

# Orden de los 5 keypoints SCRFD/InsightFace.
LEFT_EYE, RIGHT_EYE, NOSE, LEFT_MOUTH, RIGHT_MOUTH = range(5)


@dataclass(frozen=True)
class FaceDetection:
    """Un rostro detectado: bbox [x1,y1,x2,y2], 5 keypoints (x,y) y score."""

    bbox: NDArrayF
    keypoints: NDArrayF  # shape (5, 2)
    score: float

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])


def _distance(a: NDArrayF, b: NDArrayF) -> float:
    return float(np.linalg.norm(a - b))


def signals_from_keypoints(
    det: FaceDetection,
    settings: Settings,
    *,
    face_count: int = 1,
) -> FrameSignals:
    """Deriva señales de pose/expresión desde los 5 keypoints (aproximación geométrica).

    Limitación documentada: con 5 puntos NO se calcula EAR (parpadeo) ni apertura
    vertical de boca; esos retos requieren un modelo de landmarks densos.
    """
    kp = det.keypoints
    eye_mid = (kp[LEFT_EYE] + kp[RIGHT_EYE]) / 2.0
    mouth_mid = (kp[LEFT_MOUTH] + kp[RIGHT_MOUTH]) / 2.0
    iod = _distance(kp[LEFT_EYE], kp[RIGHT_EYE])
    if iod < 1e-3:
        iod = 1e-3

    # Yaw: desplazamiento horizontal de la nariz respecto al centro de los ojos.
    nose_offset_x = (kp[NOSE][0] - eye_mid[0]) / iod
    yaw_deg = float(nose_offset_x * settings.yaw_scale_deg)

    # Pitch: posición vertical de la nariz entre ojos (0) y boca (1); baseline ~0.5.
    eye_to_mouth = mouth_mid[1] - eye_mid[1]
    if abs(eye_to_mouth) < 1e-3:
        eye_to_mouth = 1e-3
    nose_ratio = (kp[NOSE][1] - eye_mid[1]) / eye_to_mouth
    pitch_deg = float((nose_ratio - 0.5) * settings.pitch_scale_deg)

    # Smile: ancho de boca normalizado por distancia interocular.
    mouth_width = _distance(kp[LEFT_MOUTH], kp[RIGHT_MOUTH])
    smile_ratio = float(mouth_width / iod)

    return FrameSignals(
        yaw_deg=yaw_deg,
        pitch_deg=pitch_deg,
        eye_aspect_ratio=float("nan"),  # no disponible con 5 puntos
        smile_ratio=smile_ratio,
        mouth_open_ratio=0.0,  # no disponible con 5 puntos
        face_count=face_count,
        detection_confidence=det.score,
    )


def _nms(dets: NDArrayF, iou_threshold: float) -> list[int]:
    """Non-Maximum Suppression sobre [N,5] (x1,y1,x2,y2,score)."""
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        inds = np.where(ovr <= iou_threshold)[0]
        order = order[inds + 1]
    return keep


def _distance2bbox(points: NDArrayF, distance: NDArrayF) -> NDArrayF:
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def _distance2kps(points: NDArrayF, distance: NDArrayF) -> NDArrayF:
    preds = []
    for i in range(0, distance.shape[1], 2):
        px = points[:, i % 2] + distance[:, i]
        py = points[:, i % 2 + 1] + distance[:, i + 1]
        preds.append(px)
        preds.append(py)
    return np.stack(preds, axis=-1)


class ScrfdDetector:
    """Wrapper ONNX de SCRFD con keypoints (modelo *_bnkps)."""

    _STRIDES = (8, 16, 32)
    _NUM_ANCHORS = 2
    _IOU = 0.4

    def __init__(self, model_path: str, settings: Settings) -> None:
        import onnxruntime as ort  # carga perezosa

        self._settings = settings
        self._session: ort.InferenceSession = ort.InferenceSession(
            model_path, providers=list(settings.onnx_providers)
        )
        self._input_name = self._session.get_inputs()[0].name
        self._input_size = (settings.detection_size, settings.detection_size)
        self._center_cache: dict[tuple[int, int, int], NDArrayF] = {}

    def detect(self, image_bgr: "np.ndarray") -> list[FaceDetection]:  # type: ignore[type-arg]
        """Detecta rostros en una imagen BGR (formato OpenCV)."""
        import cv2  # carga perezosa

        det_w, det_h = self._input_size
        img_h, img_w = image_bgr.shape[:2]
        scale = min(det_w / img_w, det_h / img_h)
        new_w, new_h = int(round(img_w * scale)), int(round(img_h * scale))
        resized = cv2.resize(image_bgr, (new_w, new_h))
        canvas = np.zeros((det_h, det_w, 3), dtype=np.uint8)
        canvas[:new_h, :new_w, :] = resized

        blob = cv2.dnn.blobFromImage(
            canvas, 1.0 / 128.0, (det_w, det_h), (127.5, 127.5, 127.5), swapRB=True
        )
        outputs = self._session.run(None, {self._input_name: blob})

        scores_list: list[NDArrayF] = []
        bboxes_list: list[NDArrayF] = []
        kps_list: list[NDArrayF] = []
        fmc = len(self._STRIDES)
        thr = self._settings.detection_threshold

        for idx, stride in enumerate(self._STRIDES):
            scores = outputs[idx]
            bbox_preds = outputs[idx + fmc] * stride
            kps_preds = outputs[idx + fmc * 2] * stride
            height = det_h // stride
            width = det_w // stride
            key = (height, width, stride)
            if key in self._center_cache:
                anchor_centers = self._center_cache[key]
            else:
                ax, ay = np.meshgrid(np.arange(width), np.arange(height))
                anchor_centers = np.stack([ax, ay], axis=-1).astype(np.float32)
                anchor_centers = (anchor_centers * stride).reshape(-1, 2)
                anchor_centers = np.stack(
                    [anchor_centers] * self._NUM_ANCHORS, axis=1
                ).reshape(-1, 2)
                self._center_cache[key] = anchor_centers

            pos = np.where(scores.reshape(-1) >= thr)[0]
            if pos.size == 0:
                continue
            bboxes = _distance2bbox(anchor_centers, bbox_preds.reshape(-1, 4))
            kpss = _distance2kps(anchor_centers, kps_preds.reshape(-1, 10))
            scores_list.append(scores.reshape(-1)[pos])
            bboxes_list.append(bboxes[pos])
            kps_list.append(kpss[pos])

        if not scores_list:
            return []

        scores_all = np.concatenate(scores_list)
        bboxes_all = np.concatenate(bboxes_list) / scale
        kps_all = np.concatenate(kps_list) / scale
        pre_det = np.hstack([bboxes_all, scores_all[:, None]]).astype(np.float32)
        keep = _nms(pre_det, self._IOU)

        results: list[FaceDetection] = []
        for i in keep:
            bbox = pre_det[i, :4]
            if min(bbox[2] - bbox[0], bbox[3] - bbox[1]) < self._settings.min_face_size:
                continue
            results.append(
                FaceDetection(
                    bbox=bbox.astype(np.float32),
                    keypoints=kps_all[i].reshape(5, 2).astype(np.float32),
                    score=float(pre_det[i, 4]),
                )
            )
        return results


def load_detector(settings: Settings, model_path: str) -> ScrfdDetector:
    """Crea el detector SCRFD desde un fichero ONNX existente."""
    return ScrfdDetector(model_path, settings)


__all__ = [
    "FaceDetection",
    "ScrfdDetector",
    "load_detector",
    "signals_from_keypoints",
]
