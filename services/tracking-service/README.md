# tracking-service (Go)

Servicio de **tracking GPS** de VEO (movilidad segura, Lima). Ingiere posiciones de
conductores por **MQTT** (1 Hz), mantiene **presencia** en Redis con un **hot index H3**
para dispatch, hace **geofencing** (point-in-polygon / celdas H3 + bbox de Lima),
persiste el **histórico** en ClickHouse, publica eventos de dominio a **Kafka** y reenvía
la ubicación a los suscriptores de un viaje vía **SSE**.

- Lenguaje: **Go 1.26**
- Puerto HTTP: **3004** (`/health`, `/health/ready`, `/metrics`, `/tracking/{tripId}`)
- Sin Postgres. Sin SaaS. Todo self-hosted.

## Arquitectura

```
MQTT (veo/driver/+/location)
        │  ping {driverId,lat,lon,speed,heading,accuracy,recordedAt}
        ▼
  ingest.Pipeline ──┬─► presence (Redis: driver:loc:{id} TTL 60s + h3:available:{cell})
                    ├─► history (ClickHouse: gps_pings, TTL 90d)
                    ├─► geofence (zonas + Lima bbox BR-D03) ─► Kafka driver.entered_zone
                    ├─► fan-out hub ─► SSE /tracking/{tripId}
                    └─► Kafka driver.location_updated (throttling por driver)
```

Capas (cada paquete depende de abstracciones, no de infraestructura concreta):

| Paquete | Responsabilidad |
|---|---|
| `internal/domain` | Entidades puras (`Ping`, `Point`, `PresenceStatus`) |
| `internal/geo` | Cálculo de celdas H3 (uber/h3-go) |
| `internal/presence` | Redis: presencia + hot index H3 |
| `internal/geofence` | Point-in-polygon, membresía H3, Lima bbox, transiciones |
| `internal/history` | ClickHouse: DDL + inserción por lotes |
| `internal/events` | EventEnvelope (UUIDv7) + productor Kafka |
| `internal/ingest` | MQTT + pipeline de orquestación |
| `internal/api` | HTTP health/ready/metrics + SSE fan-out |
| `internal/obs` | slog (redacción PII), Prometheus, OTel |
| `internal/config` | Configuración por entorno |

## Desarrollo

Levanta la infra del monorepo (Mosquitto, Redis, Kafka, ClickHouse):

```bash
pnpm dev-stack:up      # desde la raíz del monorepo
```

Compilar / verificar / testear:

```bash
go build ./...
go vet ./...
go test ./...
go run ./cmd/server
```

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `TRACKING_HTTP_ADDR` | `:3004` | Dirección HTTP |
| `MQTT_BROKER_URL` | `tcp://localhost:1883` | Broker MQTT |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | – | Credenciales MQTT |
| `MQTT_TOPIC` | `veo/driver/+/location` | Patrón de suscripción |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `KAFKA_BROKERS` | `localhost:9094` | Brokers Kafka (EXTERNAL) |
| `CLICKHOUSE_ADDR` | `localhost:9000` | ClickHouse (protocolo nativo) |
| `CLICKHOUSE_DB` | `veo_analytics` | Base de datos |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `veo` / `veo_dev` | Credenciales |
| `PRESENCE_TTL` | `60s` | TTL de presencia |
| `H3_RESOLUTION` | `9` | Resolución del hot index |
| `LOCATION_PUBLISH_INTERVAL` | `1s` | Throttle de `driver.location_updated` por driver |
| `TRACKING_ZONES_PATH` | – | JSON de zonas geofence (opcional) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | OTLP/HTTP; vacío = tracing off |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

## Endpoints

- `GET /health` — liveness.
- `GET /health/ready` — readiness (Redis + Kafka + ClickHouse + MQTT).
- `GET /metrics` — Prometheus.
- `GET /tracking/{tripId}` — SSE con la ubicación del conductor del viaje.
  Resuelve el conductor desde Redis (`trip:driver:{tripId}`) o `?driverId=`.

Ejemplo de consumo SSE:

```bash
curl -N http://localhost:3004/tracking/trip-123
# event: location
# data: {"driverId":"drv-1","point":{"lat":-12.04,"lon":-77.04},"h3":"89283082837ffff",...}
```

## Ingesta de un ping (MQTT)

Topic: `veo/driver/{driverId}/location` · Payload:

```json
{ "driverId": "drv-1", "tripId": "trip-9", "lat": -12.0464, "lon": -77.0428,
  "speed": 8.3, "heading": 90, "accuracy": 5, "recordedAt": "2026-05-28T23:00:00Z" }
```

## Zonas de geofence

Archivo JSON opcional (`TRACKING_ZONES_PATH`). Ver `configs/zones.example.json`.
Cada zona se define por polígono (ray casting) **o** por celdas H3.

## Eventos

Ver [`docs/events.md`](docs/events.md).

## Docker

```bash
docker build -t veo/tracking-service .
docker run --rm -p 3004:3004 --env-file ../../.env veo/tracking-service
```
