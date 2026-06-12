FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    VEO_BIO_PORT=3013 \
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

# Crea el dir de modelos ONNX y cede el workdir al usuario no-root para que
# pueda leer el código y leer/escribir models/ (descarga en runtime o volumen).
RUN mkdir -p /app/models && chown -R veo:veo /app

EXPOSE 3013

# Aprovisiona los modelos en build (requiere red) o monta un volumen en runtime:
#   docker run -v /host/models:/app/models ...
# RUN python scripts/download_models.py

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -fsS http://localhost:3013/health || exit 1

# A partir de aquí el contenedor corre sin privilegios de root.
USER veo

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3013"]
