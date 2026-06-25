FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    VEO_BIO_PORT=3015 \
    VEO_BIO_MODEL_DIR=/app/models

WORKDIR /app

# Dependencias de sistema para opencv-python-headless / onnxruntime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Usuario no-root (no corre como root). UID/GID 1000 alineado con el
# securityContext del manifiesto K8s (runAsUser: 1000, fsGroup: 1000).
RUN groupadd --system --gid 1000 veo \
    && useradd --system --uid 1000 --gid veo --no-create-home --shell /usr/sbin/nologin veo

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app/ ./app/
COPY scripts/ ./scripts/
COPY pyproject.toml ./

# Aprovisiona los modelos ONNX EN BUILD (self-hosted, HORNEADOS en la imagen). Resuelve el deploy con
# readOnlyRootFilesystem: los .onnx ya están presentes y NO se descargan en runtime (no hace falta
# initContainer ni volumen de modelos). Trade-off: la imagen crece ~190MB. Soberanía: espejá
# buffalo_l.zip en un registry/S3 propio y apuntá download_models.py ahí (hoy baja de la release oficial).
# Luego cede el workdir al usuario no-root (incluye models/).
RUN python scripts/download_models.py \
    && chown -R veo:veo /app

EXPOSE 3015

# /health/ready (no /health): refleja modelos + PAD anti-spoofing. Con REQUIRE_PASSIVE_LIVENESS=true (prod) un
# pod sin PAD da 503 → el orquestador NO lo enruta (fail-closed: nunca enrola sin liveness). En dev queda 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://localhost:3015/health/ready || exit 1

# A partir de aquí el contenedor corre sin privilegios de root.
USER veo

# El puerto lo resuelve la config (VEO_BIO_PORT, default 3015) vía app/main.py — sin hardcode.
CMD ["python", "-m", "app.main"]
