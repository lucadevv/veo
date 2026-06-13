# VEO · biometric-service

Servicio de **verificación facial self-hosted** para VEO (movilidad segura, Lima).
Python (FastAPI) + **ONNX Runtime**. **Sin SaaS, sin cloud, sin mocks** en el dominio:
detección facial real (SCRFD), embeddings reales (ArcFace), **liveness activo por reto**
y **match por similitud coseno con umbral ≥ 0.90** (BR-I02). Soberanía de datos: ningún
dato biométrico sale a terceros.

- **Puerto HTTP:** `3015`
- **Modelos:** InsightFace `buffalo_l` (SCRFD-10G + ArcFace `w600k_r50`, embedding 512-d)
- **Runtime de inferencia:** `onnxruntime` (CPU por defecto; configurable a GPU)

---

## 1. Arquitectura

```
app/
  main.py            FastAPI (lifespan, OTel, métricas, health)
  config.py          pydantic-settings (env VEO_BIO_*)
  domain.py          máquina de decisión PASS / FAIL / BLOCKED
  challenge_store.py store de retos de liveness (1 solo uso, expiración → anti-replay)
  telemetry.py       métricas Prometheus + OpenTelemetry
  face/
    detector.py      SCRFD (ONNX): detección + 5 landmarks + señales de pose
    embedder.py      ArcFace (ONNX): alineación 112x112 + embedding 512-d L2
    liveness.py      evaluación de retos activos sobre señales geométricas
    matcher.py       similitud coseno + umbral (matemática pura, testeada)
    imaging.py       decodificación de imágenes (bytes / base64) → BGR
    pipeline.py      orquestador: detección + liveness + embedding + match
  api/
    routes.py        endpoints HTTP
    schemas.py       modelos pydantic (contrato)
scripts/download_models.py   descarga de modelos ONNX a models/
tests/                       pytest (matching, liveness, decisión, store)
```

**Separación de capas (SOLID):** la matemática de `matcher`, `liveness` y `domain` **no
depende de ONNX/OpenCV** (solo numpy), por lo que es testeable de forma aislada con
vectores controlados. Los imports pesados (`onnxruntime`, `cv2`) son **perezosos**.

---

## 2. Setup local

```bash
cd services/biometric-service
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

# Descargar modelos ONNX (≈190 MB) a models/
python scripts/download_models.py

# Arrancar
uvicorn app.main:app --host 0.0.0.0 --port 3015
# o: python -m app.main
```

> **Estado en este entorno:** `onnxruntime 1.19.2` y `opencv-python-headless 4.11`
> instalaron correctamente, y los modelos se descargaron y ejecutaron inferencia real
> (detector SCRFD + embedder ArcFace 512-d, self-cosine = 1.0).

### Tests

```bash
. .venv/bin/activate
python -m pytest          # 44 tests
```

Los tests cubren la **lógica real** (similitud coseno y umbral con vectores controlados,
liveness por reto, y la máquina de decisión PASS/FAIL/BLOCKED) y **no requieren** los
modelos ONNX descargados.

---

## 3. Aprovisionamiento de modelos (producción)

`scripts/download_models.py` descarga el pack open-source `buffalo_l` de InsightFace:

- **Fuente:** `https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip`
- **Licencia:** modelos InsightFace (uso no comercial del *model zoo* — para uso comercial,
  reentrenar/usar pesos con licencia adecuada). El **código** del servicio es propio.
- Extrae `det_10g.onnx` (detector SCRFD-10G con keypoints) y `w600k_r50.onnx` (ArcFace).

**Soberanía / producción:**
1. Ejecuta la descarga **una vez**, valida los `.onnx` y **espéjalos en tu storage
   privado** (MinIO/S3 on-prem).
2. En runtime, monta los modelos en `MODEL_DIR` (volumen) o hornéalos en la imagen:
   ```bash
   docker run -v /opt/veo/models:/app/models veo/biometric-service
   ```
3. Configura `VEO_BIO_MODEL_DIR`, `VEO_BIO_DETECTOR_MODEL`, `VEO_BIO_EMBEDDER_MODEL` si
   usas nombres/rutas distintos.

Si no hay red para descargar, el servicio **arranca en modo degradado**:
`GET /health/ready` devuelve `503` y `/v1/verify` devuelve `503` hasta que los modelos
estén presentes (pon `VEO_BIO_REQUIRE_MODELS=true` para fallar el arranque en su lugar).

---

## 4. Configuración (env, prefijo `VEO_BIO_`)

| Variable | Default | Descripción |
|---|---|---|
| `VEO_BIO_HOST` | `0.0.0.0` | host de bind |
| `VEO_BIO_PORT` | `3015` | puerto HTTP |
| `VEO_BIO_MODEL_DIR` | `models` | carpeta de modelos ONNX |
| `VEO_BIO_DETECTOR_MODEL` | `det_10g.onnx` | fichero del detector |
| `VEO_BIO_EMBEDDER_MODEL` | `w600k_r50.onnx` | fichero del recognizer |
| `VEO_BIO_MATCH_THRESHOLD` | `0.90` | **umbral de match (BR-I02)** |
| `VEO_BIO_REQUIRE_MODELS` | `false` | si `true`, falla el arranque sin modelos |
| `VEO_BIO_DETECTION_THRESHOLD` | `0.5` | confianza mínima del detector |
| `VEO_BIO_MIN_FACE_SIZE` | `80` | tamaño mínimo (px) de rostro |
| `VEO_BIO_CHALLENGE_TTL_SECONDS` | `60` | expiración del reto de liveness |
| `VEO_BIO_MIN_FRAMES_FOR_LIVENESS` | `3` | frames mínimos para liveness |
| `VEO_BIO_LIVENESS_ACTIONS` | `TURN_LEFT,TURN_RIGHT,NOD,SMILE` | retos habilitados |
| `VEO_BIO_OTEL_ENABLED` | `false` | activa OpenTelemetry |
| `VEO_BIO_OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | endpoint OTLP/HTTP |

---

## 5. Liveness activo (anti-spoofing)

El servidor emite un **reto aleatorio** (challenge-response). El cliente captura una
**secuencia de frames** mientras realiza la acción. El servicio detecta el rostro en cada
frame, deriva señales geométricas (yaw/pitch de cabeza, ratios de boca) y verifica que la
secuencia **satisface el reto**. Una **foto estática nunca supera** un reto de movimiento.

Retos soportados con los 5 landmarks de SCRFD: `TURN_LEFT`, `TURN_RIGHT`, `NOD`, `SMILE`.
Los retos `BLINK` y `OPEN_MOUTH` requieren un modelo de **landmarks densos** (p. ej.
`2d106det.onnx`, también en `buffalo_l`) para EAR/apertura vertical; el código ya los
evalúa cuando esas señales están disponibles. Habilítalos vía `VEO_BIO_LIVENESS_ACTIONS`
tras integrar el modelo denso.

Cada reto es de **un solo uso** y expira (`challenge_store`), mitigando replay.

---

## 6. Contrato REST (para el adapter live de identity-service)

Base URL = `BIOMETRIC_SERVICE_URL` (p. ej. `http://biometric-service:3015`).

### `POST /v1/liveness/challenge`
Inicia un reto de liveness.

**Response 200**
```json
{
  "challengeId": "x7Qk...",
  "action": "TURN_LEFT",
  "instructions": "Gira lentamente la cabeza hacia tu izquierda",
  "expiresAt": "2026-05-28T23:59:00+00:00"
}
```

### `POST /v1/verify`  (JSON / base64)
Ejecuta el pipeline completo: detección (rechaza si no hay **exactamente 1** rostro claro)
→ liveness (valida el reto) → embedding → match coseno contra la referencia.

**Request (application/json)**
```json
{
  "driverId": "drv_123",
  "shiftId": "shift_456",
  "challengeId": "x7Qk...",
  "frames": ["<base64-jpeg>", "<base64-jpeg>", "..."],
  "referenceEmbedding": [0.01, -0.23, ...],
  "referencePhoto": "<base64-jpeg>"
}
```
- `frames`: secuencia temporal de imágenes del reto (≥ `MIN_FRAMES_FOR_LIVENESS`).
- Referencia: **`referenceEmbedding`** (vector, recomendado: se calcula una vez en el
  enrolamiento) **o** **`referencePhoto`** (base64; el servicio calcula su embedding).

**Response 200**
```json
{
  "result": "PASS",
  "score": 0.964231,
  "livenessPassed": true,
  "matchPassed": true,
  "reason": "Verificación exitosa",
  "takenAt": "2026-05-28T23:58:10+00:00"
}
```

- `result`: `PASS` | `FAIL` | `BLOCKED`
  - `PASS` — un rostro claro, liveness OK y `score ≥ 0.90`.
  - `FAIL` — reto válido pero no superó liveness y/o match, o ≠ 1 rostro.
  - `BLOCKED` — reto inválido/vencido/desconocido (sesión no confiable / replay).
- `score` ∈ `[0,1]` (similitud coseno saturada). `score < 0.90 → matchPassed=false`.

> **Errores:** `422` (entrada inválida: sin referencia, frame corrupto, foto de referencia
> sin 1 rostro), `503` (modelos no disponibles — modo degradado).

### `POST /v1/verify/multipart`  (multipart/form-data)
Igual que el anterior pero con ficheros. Campos form: `driverId`, `challengeId`,
`shiftId?`; ficheros: `frames` (múltiples), `reference_photo`.

### Salud / observabilidad
| Endpoint | Descripción |
|---|---|
| `GET /health` | liveness del proceso (200 siempre que el proceso esté arriba) |
| `GET /health/ready` | readiness: `200` si los modelos están cargados, `503` si no |
| `GET /metrics` | métricas Prometheus |

**Métricas:** `veo_biometric_verify_total{result}`, `veo_biometric_liveness_total{passed}`,
`veo_biometric_challenge_issued_total{action}`, `veo_biometric_match_score` (histograma),
`veo_biometric_verify_seconds` (histograma).

---

## 7. Relación con identity-service (BR-I02)

`identity-service` orquesta el gate de turno (`startShift`). Este servicio **solo devuelve
el resultado real** de cada verificación. La política de negocio —**3 intentos** y
**bloqueo de 1 hora**— la gestiona `identity-service` (Redis). El adapter live llama a
`POST /v1/verify` y mapea la respuesta a su `BiometricVerifyResult`.

> Nota de integración: el `BiometricServiceClient` actual de identity-service apunta a
> `POST {baseUrl}/verify` con `{userId, kind, sessionRef}`. Para usar este servicio, el
> adapter debe migrarse al contrato `POST /v1/verify` documentado arriba (con
> `driverId`, `challengeId`, `frames`, `referenceEmbedding/referencePhoto`), previa
> obtención del reto vía `POST /v1/liveness/challenge`.

---

## 8. Docker

```bash
docker build -t veo/biometric-service .
docker run -p 3015:3015 -v /opt/veo/models:/app/models veo/biometric-service
```

La imagen base es `python:3.11-slim` con `libgl1`/`libglib2.0-0` (requisitos de OpenCV).
Monta los modelos como volumen o descomenta la línea `RUN python scripts/download_models.py`
en el `Dockerfile` para hornearlos en build.
