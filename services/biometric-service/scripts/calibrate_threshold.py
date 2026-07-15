#!/usr/bin/env python3
"""Calibración del umbral de match biométrico por FMR/FNMR (deuda config.py:doc_match_threshold).

Computa FMR(τ) / FNMR(τ), la curva DET (en tabla), el EER, y el operating point recomendado
por FMR OBJETIVO (no por EER — ver docs/threshold-calibration.md §4) sobre un conjunto de pares
etiquetados GENUINE (misma persona) / IMPOSTOR (personas distintas).

REUSA la métrica REAL del servicio (app.face.matcher.cosine_similarity / match_score) — no la
reimplementa. En modo --pairs-csv reusa además el embedder ArcFace real (app.face.embedder), o sea
el MISMO pipeline que /v1/face-match, para que los scores sean los de producción.

Modos de entrada (elegir uno):
  --scores-csv PATH   CSV con columnas  label,score[,group]   (label ∈ genuine|impostor|1|0)
                      score = similitud coseno YA computada. Modo honesto y siempre ejecutable.
  --pairs-csv PATH    CSV con columnas  label,image_a,image_b[,group]
                      El harness computa el score con el pipeline real (requiere modelos ONNX).
  --demo              Distribución sintética (sin dataset) — solo para ver el FORMATO de salida.

Uso:
    cd services/biometric-service && source .venv/bin/activate
    python scripts/calibrate_threshold.py --demo
    python scripts/calibrate_threshold.py --scores-csv data/doc_scores.csv
    python scripts/calibrate_threshold.py --pairs-csv data/doc_pairs.csv --model-dir models
    python scripts/calibrate_threshold.py --scores-csv data/doc_scores.csv --fmr-targets 0.01,0.001,0.0001

Salida: tabla FMR/FNMR por τ, EER, y operating points por FMR objetivo con el FNMR resultante.
NO decide el número final: produce la evidencia para que el dueño lo fije (ver runbook).
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# El script vive en services/biometric-service/scripts/ → agregamos la raíz del servicio al path
# para importar el pipeline REAL (mismo motor que /v1/face-match), sin reimplementar la métrica.
_SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

from app.face.matcher import cosine_similarity, match_score, to_vector  # noqa: E402

_GENUINE_LABELS = {"genuine", "1", "true", "same", "mated"}
_IMPOSTOR_LABELS = {"impostor", "0", "false", "different", "non-mated", "nonmated"}


# --------------------------------------------------------------------------------------
# Núcleo de métricas (numpy puro). Trabaja sobre scores ya computados.
# --------------------------------------------------------------------------------------
@dataclass(frozen=True)
class OperatingPoint:
    fmr_target: float
    threshold: float
    fmr: float
    fnmr: float
    reachable: bool  # False si ningún τ del barrido alcanza el FMR objetivo con este dataset


def fmr_at(impostor: np.ndarray, tau: float) -> float:
    """False Match Rate: fracción de IMPOSTORES con score >= τ (impostor ACEPTADO = riesgo)."""
    if impostor.size == 0:
        return float("nan")
    return float(np.count_nonzero(impostor >= tau) / impostor.size)


def fnmr_at(genuine: np.ndarray, tau: float) -> float:
    """False Non-Match Rate: fracción de GENUINOS con score < τ (legítimo RECHAZADO = fricción)."""
    if genuine.size == 0:
        return float("nan")
    return float(np.count_nonzero(genuine < tau) / genuine.size)


def sweep(
    genuine: np.ndarray, impostor: np.ndarray, step: float
) -> List[Tuple[float, float, float]]:
    """Barre τ en [0,1] y devuelve [(τ, FMR, FNMR)] (grilla fina para DET/EER/operating points)."""
    taus = np.round(np.arange(0.0, 1.0 + step, step), 6)
    return [(float(t), fmr_at(impostor, float(t)), fnmr_at(genuine, float(t))) for t in taus]


def equal_error_rate(curve: Sequence[Tuple[float, float, float]]) -> Tuple[float, float]:
    """EER: τ donde |FMR − FNMR| es mínimo. Devuelve (τ_eer, eer). Solo referencia (no operating point)."""
    best_tau, best_eer, best_gap = 0.0, 1.0, float("inf")
    for tau, fmr, fnmr in curve:
        if np.isnan(fmr) or np.isnan(fnmr):
            continue
        gap = abs(fmr - fnmr)
        if gap < best_gap:
            best_gap, best_tau, best_eer = gap, tau, (fmr + fnmr) / 2.0
    return best_tau, best_eer


def operating_point_for_fmr(
    curve: Sequence[Tuple[float, float, float]], fmr_target: float
) -> OperatingPoint:
    """Menor τ tal que FMR(τ) <= objetivo; lee el FNMR resultante en ese τ.

    Menor τ = el menos estricto que aún cumple el FMR → minimiza el FNMR (fricción) sujeto a
    la seguridad exigida. Si ningún τ alcanza el objetivo (dataset chico / modelo laxo), toma el τ
    de menor FMR y marca reachable=False (señal de "conseguí más pares impostor o cambiá de modelo").
    """
    candidates = [(t, fmr, fnmr) for (t, fmr, fnmr) in curve if not np.isnan(fmr) and fmr <= fmr_target]
    if candidates:
        tau, fmr, fnmr = min(candidates, key=lambda row: row[0])
        return OperatingPoint(fmr_target, tau, fmr, fnmr, reachable=True)
    valid = [(t, fmr, fnmr) for (t, fmr, fnmr) in curve if not np.isnan(fmr)]
    tau, fmr, fnmr = min(valid, key=lambda row: row[1])
    return OperatingPoint(fmr_target, tau, fmr, fnmr, reachable=False)


# --------------------------------------------------------------------------------------
# Carga de datos
# --------------------------------------------------------------------------------------
def _parse_label(raw: str) -> Optional[bool]:
    """True=genuine, False=impostor, None=desconocido."""
    v = raw.strip().lower()
    if v in _GENUINE_LABELS:
        return True
    if v in _IMPOSTOR_LABELS:
        return False
    return None


def load_scores_csv(path: Path) -> Tuple[np.ndarray, np.ndarray, Dict[str, Tuple[List[float], List[float]]]]:
    """Lee label,score[,group]. Devuelve (genuine[], impostor[], por_grupo{group:(gen,imp)})."""
    gen: List[float] = []
    imp: List[float] = []
    groups: Dict[str, Tuple[List[float], List[float]]] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None or "label" not in reader.fieldnames or "score" not in reader.fieldnames:
            raise ValueError("El CSV de scores debe tener cabeceras 'label' y 'score' (opcional 'group').")
        for i, row in enumerate(reader, start=2):
            label = _parse_label(row["label"])
            if label is None:
                raise ValueError(f"Fila {i}: label desconocido '{row['label']}' (usá genuine/impostor).")
            score = float(row["score"])
            group = (row.get("group") or "").strip()
            (gen if label else imp).append(score)
            if group:
                g, m = groups.setdefault(group, ([], []))
                (g if label else m).append(score)
    return np.asarray(gen, dtype=np.float64), np.asarray(imp, dtype=np.float64), groups


def load_pairs_csv(
    path: Path, model_dir: str
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Tuple[List[float], List[float]]]]:
    """Lee label,image_a,image_b[,group] y computa el score con el pipeline REAL del servicio.

    Usa el MISMO motor que /v1/face-match: SCRFD (best_detection) + ArcFace (embed) +
    cosine/match_score. Requiere los modelos ONNX presentes en model_dir.
    """
    import cv2  # carga perezosa; solo en modo pares

    from app.config import get_settings
    from app.face.pipeline import BiometricPipeline

    settings = get_settings()
    if model_dir:
        os.environ["VEO_BIO_MODEL_DIR"] = model_dir
        get_settings.cache_clear()  # type: ignore[attr-defined]
        settings = get_settings()

    pipeline = BiometricPipeline(settings)
    pipeline.load()
    if not pipeline.ready:
        raise RuntimeError(
            f"Modelos ONNX no disponibles ({pipeline.load_error}). "
            "Ejecutá scripts/download_models.py o pasá --model-dir con det_10g.onnx + w600k_r50.onnx."
        )

    def _embed(image_path: str) -> Optional[np.ndarray]:
        img = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"No se pudo leer la imagen: {image_path}")
        count, detection = pipeline.best_detection(img)
        if count != 1 or detection is None:
            return None  # 0 rostros / varios → Failure-To-Acquire, no entra en la curva
        return pipeline.embed(img, detection)

    gen: List[float] = []
    imp: List[float] = []
    groups: Dict[str, Tuple[List[float], List[float]]] = {}
    fta = 0
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        required = {"label", "image_a", "image_b"}
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise ValueError("El CSV de pares debe tener 'label','image_a','image_b' (opcional 'group').")
        for i, row in enumerate(reader, start=2):
            label = _parse_label(row["label"])
            if label is None:
                raise ValueError(f"Fila {i}: label desconocido '{row['label']}'.")
            emb_a = _embed(row["image_a"])
            emb_b = _embed(row["image_b"])
            if emb_a is None or emb_b is None:
                fta += 1
                continue
            score = match_score(to_vector(emb_a), to_vector(emb_b))
            group = (row.get("group") or "").strip()
            (gen if label else imp).append(score)
            if group:
                g, m = groups.setdefault(group, ([], []))
                (g if label else m).append(score)
    if fta:
        print(f"[aviso] {fta} pares descartados por Failure-To-Acquire (0 o >1 rostros).", file=sys.stderr)
    return np.asarray(gen, dtype=np.float64), np.asarray(imp, dtype=np.float64), groups


def synthesize_demo(seed: int = 7) -> Tuple[np.ndarray, np.ndarray]:
    """Distribución SINTÉTICA con forma ArcFace-like (doc↔selfie). SOLO demo de formato — NO calibra nada.

    genuine ~ N(0.42, 0.09) (misma persona, DNI viejo/baja-res cae bajo);
    impostor ~ N(0.06, 0.06) (personas distintas, coseno ~0). Recortadas a [-1,1].
    """
    rng = np.random.default_rng(seed)
    genuine = np.clip(rng.normal(0.42, 0.09, size=1200), -1.0, 1.0)
    impostor = np.clip(rng.normal(0.06, 0.06, size=40000), -1.0, 1.0)
    return genuine.astype(np.float64), impostor.astype(np.float64)


# --------------------------------------------------------------------------------------
# Reporte
# --------------------------------------------------------------------------------------
def _fmt_pct(x: float) -> str:
    return "   nan " if np.isnan(x) else f"{x * 100:6.3f}%"


def print_report(
    genuine: np.ndarray,
    impostor: np.ndarray,
    fmr_targets: Sequence[float],
    step: float,
    current_threshold: float,
    label: str = "GLOBAL",
) -> None:
    print(f"\n{'=' * 78}\n  CALIBRACIÓN — {label}\n{'=' * 78}")
    if genuine.size == 0 or impostor.size == 0:
        print("  [error] hacen falta pares GENUINE e IMPOSTOR (ambos > 0). Nada que calibrar.")
        return
    print(f"  pares genuine : {genuine.size:>8,}   media={genuine.mean():.4f}  min={genuine.min():.4f}")
    print(f"  pares impostor: {impostor.size:>8,}   media={impostor.mean():.4f}  max={impostor.max():.4f}")

    curve = sweep(genuine, impostor, step)

    # Tabla resumida (cada ~0.05 para no inundar; el barrido interno es fino).
    print(f"\n  DET / barrido (FMR = impostor aceptado · FNMR = legítimo rechazado)")
    print(f"  {'τ':>6} | {'FMR':>8} | {'FNMR':>8}")
    print(f"  {'-' * 6}-+-{'-' * 8}-+-{'-' * 8}")
    for tau, fmr, fnmr in curve:
        if abs((tau / 0.05) - round(tau / 0.05)) < 1e-6:  # múltiplos de 0.05
            mark = "  <- doc_match actual" if abs(tau - current_threshold) < step / 2 else ""
            print(f"  {tau:6.2f} | {_fmt_pct(fmr)} | {_fmt_pct(fnmr)}{mark}")

    tau_eer, eer = equal_error_rate(curve)
    print(f"\n  EER (solo referencia de separabilidad, NO operating point): "
          f"{eer * 100:.3f}% @ τ={tau_eer:.3f}")

    # Score al umbral actual.
    print(f"\n  Umbral ACTUAL (config) τ={current_threshold:.2f}: "
          f"FMR={_fmt_pct(fmr_at(impostor, current_threshold)).strip()}  "
          f"FNMR={_fmt_pct(fnmr_at(genuine, current_threshold)).strip()}")

    print(f"\n  OPERATING POINTS por FMR OBJETIVO (elegí por FMR, no por EER — runbook §4):")
    print(f"  {'FMR obj':>9} | {'τ reco':>7} | {'FMR real':>9} | {'FNMR':>9} | nota")
    print(f"  {'-' * 9}-+-{'-' * 7}-+-{'-' * 9}-+-{'-' * 9}-+-----")
    min_impostor_for_target = {p: int(np.ceil(10.0 / p)) for p in fmr_targets}
    for p in sorted(fmr_targets, reverse=True):
        op = operating_point_for_fmr(curve, p)
        note = ""
        if not op.reachable:
            note = "INALCANZABLE con este dataset (subí τ-grid o consegí más impostores)"
        elif impostor.size < min_impostor_for_target[p]:
            note = f"pocos impostores (hay {impostor.size:,}, ~{min_impostor_for_target[p]:,} p/ estimar)"
        print(f"  {p * 100:8.3f}% | {op.threshold:7.3f} | {_fmt_pct(op.fmr)} | "
              f"{_fmt_pct(op.fnmr)} | {note}")

    print(f"\n  Lectura: para un gate KYC de seguridad se fija el FMR OBJETIVO y se ACEPTA el FNMR "
          f"resultante.\n  El EER NO aplica (costo FMR ≫ costo FNMR en VEO). Ver docs/threshold-calibration.md.")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Calibración FMR/FNMR del umbral de match biométrico (VEO).")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--scores-csv", type=Path, help="CSV label,score[,group] (scores ya computados).")
    src.add_argument("--pairs-csv", type=Path, help="CSV label,image_a,image_b[,group] (computa con el pipeline real).")
    src.add_argument("--demo", action="store_true", help="Distribución sintética (solo formato de salida).")
    parser.add_argument("--model-dir", default="models", help="Dir de modelos ONNX (modo --pairs-csv).")
    parser.add_argument("--fmr-targets", default="0.01,0.001,0.0001",
                        help="FMR objetivos separados por coma (default 1%%,0.1%%,0.01%%).")
    parser.add_argument("--step", type=float, default=0.005, help="Paso del barrido de τ (default 0.005).")
    parser.add_argument("--current-threshold", type=float, default=0.30,
                        help="Umbral actual a marcar en la tabla (default doc_match_threshold=0.30).")
    parser.add_argument("--by-group", action="store_true",
                        help="Además del global, reporta por subgrupo (columna 'group' del CSV).")
    args = parser.parse_args(argv)

    fmr_targets = [float(x) for x in args.fmr_targets.split(",") if x.strip()]

    if args.demo:
        print("[demo] Distribución SINTÉTICA — NO es calibración real, solo muestra el formato de salida.")
        genuine, impostor = synthesize_demo()
        groups: Dict[str, Tuple[List[float], List[float]]] = {}
    elif args.scores_csv:
        genuine, impostor, groups = load_scores_csv(args.scores_csv)
    else:
        genuine, impostor, groups = load_pairs_csv(args.pairs_csv, args.model_dir)

    print_report(genuine, impostor, fmr_targets, args.step, args.current_threshold, label="GLOBAL")

    if args.by_group and groups:
        print(f"\n\n{'#' * 78}\n  POR SUBGRUPO (sesgo demográfico — runbook §2.3)\n{'#' * 78}")
        for name, (g, m) in sorted(groups.items()):
            print_report(
                np.asarray(g, dtype=np.float64),
                np.asarray(m, dtype=np.float64),
                fmr_targets, args.step, args.current_threshold, label=f"grupo={name}",
            )
    elif args.by_group and not groups:
        print("\n[aviso] --by-group pedido pero el dataset no trae columna 'group'.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
