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

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app/ ./app/
COPY scripts/ ./scripts/
COPY pyproject.toml ./
RUN mkdir -p /app/models

EXPOSE 3013

# Aprovisiona los modelos en build (requiere red) o monta un volumen en runtime:
#   docker run -v /host/models:/app/models ...
# RUN python scripts/download_models.py

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -fsS http://localhost:3013/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3013"]
