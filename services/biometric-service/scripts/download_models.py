#!/usr/bin/env python3
"""Descarga los modelos ONNX open-source de InsightFace (buffalo_l) a MODEL_DIR.

Fuente: InsightFace model zoo (Apache-2.0 / MIT, self-hosted). El pack `buffalo_l`
incluye el detector SCRFD (10G, bnkps) y el recognizer ArcFace (w600k_r50).

Uso:
    python scripts/download_models.py
    VEO_BIO_MODEL_DIR=/data/models python scripts/download_models.py

Soberanía: tras la primera descarga, espeja estos .onnx en tu propio almacenamiento
(MinIO/S3 privado) y sirve desde ahí. NINGÚN dato sale a terceros en runtime.
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

# URL oficial del pack buffalo_l (contiene los .onnx). Espejar en tu storage privado.
BUFFALO_L_URL = (
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
)

# Nombres de fichero dentro del pack buffalo_l (= VEO_BIO_DETECTOR_MODEL / _EMBEDDER_MODEL).
# det_10g.onnx   → detector SCRFD-10G con keypoints (bnkps).
# w600k_r50.onnx → recognizer ArcFace ResNet50 (embedding 512-d).
DETECTOR_FILE = "det_10g.onnx"
EMBEDDER_FILE = "w600k_r50.onnx"


def _model_dir() -> Path:
    return Path(os.environ.get("VEO_BIO_MODEL_DIR", "models")).resolve()


def _download(url: str, dest: Path) -> None:
    import urllib.request

    print(f"Descargando {url} -> {dest}")
    with urllib.request.urlopen(url) as resp, open(dest, "wb") as out:  # noqa: S310
        total = int(resp.headers.get("Content-Length", 0))
        read = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            read += len(chunk)
            if total:
                pct = read * 100 // total
                print(f"\r  {pct:3d}% ({read >> 20} MiB)", end="", flush=True)
        print()


def main() -> int:
    model_dir = _model_dir()
    model_dir.mkdir(parents=True, exist_ok=True)

    detector = model_dir / DETECTOR_FILE
    embedder = model_dir / EMBEDDER_FILE
    if detector.is_file() and embedder.is_file():
        print(f"Modelos ya presentes en {model_dir}. Nada que hacer.")
        return 0

    zip_path = model_dir / "buffalo_l.zip"
    try:
        _download(BUFFALO_L_URL, zip_path)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR descargando modelos: {exc}", file=sys.stderr)
        print(
            "Sin red en este entorno. Descarga manualmente buffalo_l.zip de la fuente "
            "documentada, colócalo en MODEL_DIR y reejecuta, o extrae los .onnx a mano.",
            file=sys.stderr,
        )
        return 1

    print(f"Extrayendo {zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            name = os.path.basename(member)
            if name in (DETECTOR_FILE, EMBEDDER_FILE):
                with zf.open(member) as src, open(model_dir / name, "wb") as dst:
                    dst.write(src.read())
                print(f"  extraído {name}")
    zip_path.unlink(missing_ok=True)

    ok = detector.is_file() and embedder.is_file()
    if not ok:
        print(
            f"ERROR: no se encontraron {DETECTOR_FILE} / {EMBEDDER_FILE} en el pack.",
            file=sys.stderr,
        )
        return 1
    print(f"Listo. Modelos en {model_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
