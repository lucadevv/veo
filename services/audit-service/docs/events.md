# Eventos de `audit-service`

`audit-service` **principalmente CONSUME**: registra de forma inmutable (append-only + hash
chain + réplica WORM a S3 Object Lock) los hechos auditables del dominio. Emite un único evento
propio, `audit.recorded`, como señal *tamper-evident* de que una entrada fue registrada.

## Publica

| Topic | Schema | Disparado por | Consumidores |
|---|---|---|---|
| `audit` | `audit.recorded` (no registrado aún en `@veo/events`) | Cada entrada de auditoría registrada (vía outbox, misma tx que el append) | SIEM / dashboards de compliance, alertas |

Payload de `audit.recorded`:

```jsonc
{
  "auditId": "uuidv7",
  "seq": "123",            // string (bigint)
  "eventId": "…",          // eventId de origen (idempotencia)
  "actorId": "…",
  "action": "panic.triggered",
  "resourceType": "panic",
  "resourceId": "…",
  "hash": "sha256hex"       // hash de la entrada en la cadena
}
```

## Consume

Idempotente por `envelope.eventId` (constraint único en `audit_log.event_id`). Reprocesar un
evento no duplica la entrada.

| Topic | Schema (`@veo/events`) | Acción | resourceType / resourceId | Reintentos |
|---|---|---|---|---|
| `user` | `user.registered` | Registrar alta de usuario (KYC) | `user` / `userId` | Kafka consumer group (re-consumo) |
| `driver` | `driver.verified` | Registrar verificación de conductor | `driver` / `driverId` | idem |
| `driver` | `biometric.failed` | Registrar fallo biométrico | `driver` / `driverId` | idem |
| `panic` | `panic.triggered` | Registrar activación de pánico (BR-S04) | `panic` / `panicId` | idem |
| `panic` | `panic.acknowledged` | Registrar atención de pánico | `panic` / `panicId` | idem |
| `payment` | `payment.captured` | Registrar captura de pago | `payment` / `paymentId` | idem |
| `payment` | `payment.failed` | Registrar fallo de pago | `payment` / `paymentId` | idem |
| `payout` | `payout.processed` | Registrar liquidación a conductor | `payout` / `payoutId` | idem |
| `media` | `media.recording_started` | Registrar inicio de grabación (BR-S01) | `media` / `tripId` | idem |
| `media` | `media.archived` | Registrar archivado de grabación | `media` / `tripId` | idem |

## Contratos compartidos pendientes (no cubiertos por `@veo/events`)

Estos hechos son auditables pero **no existe aún su esquema de evento**. Cuando se definan en
`@veo/events` / `EVENT_SCHEMAS`, basta añadir un `register(...)` en `audit.consumer.ts`:

1. **Acceso a video por operador** — p.ej. `media.accessed` (operatorId, tripId, s3Key, at) desde
   `media-service`. Hoy solo se auditan inicio/archivado de grabación, no las visualizaciones.
2. **Cambios RBAC** — p.ej. `admin.role_changed` / `rbac.changed` (adminId, before[], after[], by)
   desde `identity-service`. Crítico para Ley 29733; hoy no hay evento.
3. **Solicitudes de borrado / derecho al olvido** — p.ej. `user.deletion_requested` /
   `user.deleted` desde `identity-service`.

Mientras tanto, esos hechos pueden registrarse de forma **síncrona** vía `POST /api/v1/audit`
(protegido por `InternalIdentityGuard`) o gRPC `veo.audit.v1.AuditService/Record`.
