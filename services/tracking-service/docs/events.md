# Eventos de `tracking-service`

Todos los eventos viajan por Kafka usando el **EventEnvelope** común de `@veo/events`.
Este servicio está escrito en Go y **replica** la forma JSON del envelope (no importa el paquete TS).

## EventEnvelope (contrato compartido)

```json
{
  "eventId": "0190f7e2-1c3a-7a4b-8c2d-2f6a1b3c4d5e",
  "eventType": "driver.location_updated",
  "occurredAt": "2026-05-28T23:00:00.123Z",
  "producer": "tracking-service",
  "schemaVersion": 1,
  "payload": { "...": "..." }
}
```

- `eventId`: UUIDv7 (ordenable por tiempo, RFC 9562).
- `occurredAt`: ISO-8601 / RFC3339.
- `traceId` y `dedupKey` son opcionales y **se omiten** si están vacíos.
- **Topic Kafka** = el dominio antes del punto del `eventType`.
- **Key** = `driverId` (garantiza orden por conductor en la partición).

## Publica

| eventType | Topic | Key | Disparado por | Consumidores |
|---|---|---|---|---|
| `driver.location_updated` | `driver` | `driverId` | cada ping GPS (con throttling configurable) | dispatch, trip, share |
| `driver.entered_zone` | `driver` | `driverId` | transición de entrada a una zona geofence | dispatch, ops |

### `driver.location_updated`

```json
{
  "driverId": "drv-123",
  "point": { "lat": -12.0464, "lon": -77.0428 },
  "h3": "89283082837ffff",
  "at": "2026-05-28T23:00:00.123Z"
}
```

### `driver.entered_zone`

```json
{
  "driverId": "drv-123",
  "zoneId": "centro-lima",
  "at": "2026-05-28T23:00:00.123Z"
}
```

## Consume

Ninguno por Kafka. La ingesta de posiciones llega por **MQTT** (no por el bus de eventos).

| Fuente | Topic | Acción |
|---|---|---|
| MQTT | `veo/driver/+/location` | Procesa ping: presencia, histórico, geofencing, fan-out, evento |

## Contratos auxiliares (Redis)

Keys que tracking **escribe** y otros servicios **leen**:

| Key | Tipo | TTL | Escribe | Lee |
|---|---|---|---|---|
| `driver:loc:{driverId}` | Hash `{lat,lon,status,speed,heading,h3,updatedAt}` | 60s | tracking | dispatch |
| `h3:available:{cell}` | Set de `driverId` (H3 r9) | 60s | tracking | dispatch |

Key que tracking **lee** (la escribe trip-service) para el fan-out del stream:

| Key | Tipo | Escribe | Lee |
|---|---|---|---|
| `trip:driver:{tripId}` | String `driverId` | trip-service | tracking (`GET /tracking/{tripId}`) |

## Ajustes sugeridos al contrato compartido (`packages/events`)

El payload `driverLocationUpdated` en `schemas.ts` ya coincide exactamente
(`{ driverId, point:{lat,lon}, h3, at }`), al igual que `driverEnteredZone`
(`{ driverId, zoneId, at }`). **No se requieren cambios** en el contrato TS.
