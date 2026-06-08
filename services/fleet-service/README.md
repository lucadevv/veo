# fleet-service

Servicio de **flota** de VEO (movilidad segura, Lima). Dueño de vehículos, documentos con
vencimiento e inspecciones técnicas. HTTP `:3012` · gRPC `0.0.0.0:50062` · schema Postgres `fleet`.

## Responsabilidades

- **Vehículos** (BR-D04): alta con placa válida y año ≥ 2017; estado documental agregado.
- **Documentos con vencimiento** (BR-I04): Licencia A1, SOAT, Tarjeta de propiedad, Antecedentes e ITV.
- **Inspecciones** (BR-D04): registro y cálculo de la próxima inspección trimestral.
- **Cron de vencimientos** (BR-I04): recalcula estados, emite alertas (30/15/7/1 días) y suspende
  conductores con documentos críticos vencidos. Eventos vía outbox → Kafka.

## Reglas de negocio

- **BR-I04** — Estado del documento derivado de `expiresAt`: `VALID`; `EXPIRING_SOON` si faltan ≤30
  días; `EXPIRED` si ya pasó. Alertas en 30/15/7/1 días (una por hito). Documento **crítico**
  (Licencia A1 / SOAT / Tarjeta) `EXPIRED` ⇒ suspensión del conductor (evento `fleet.driver.suspended`).
- **BR-D04** — Vehículo: año ≥ 2017; SOAT e ITV vigentes; inspección trimestral
  (`nextDueAt = inspectedAt + 3 meses`).
- **BR-D05** — Licencia A1 obligatoria. La validación de edad del conductor (21–65) la realiza
  `identity-service` (dependencia documentada, no implementada aquí).
- **Antecedentes / RENIEC** — Revisión **manual** del operador (estado `PENDING_REVIEW` →
  `VALID`/`REJECTED` vía `POST /documents/:id/review`, RBAC). La integración automática es fase 4:
  puerto `BackgroundCheckProvider` documentado en `src/ports/background-check/`, sin implementación live.

## Endpoints (prefijo `/api/v1`)

| Método | Ruta | RBAC | Descripción |
|---|---|---|---|
| POST | `/vehicles` | COMPLIANCE_SUPERVISOR / ADMIN | Registrar vehículo (BR-D04) |
| GET | `/vehicles/:id` | interno | Obtener vehículo |
| POST | `/documents` | interno | Subir documento (→ PENDING_REVIEW) |
| GET | `/documents?ownerId=` | interno | Documentos de un dueño |
| POST | `/documents/:id/review` | COMPLIANCE_SUPERVISOR / ADMIN | Revisión manual VALID/REJECTED |
| POST | `/inspections` | COMPLIANCE_SUPERVISOR / ADMIN | Registrar inspección técnica |
| GET | `/inspections?vehicleId=` | interno | Inspecciones de un vehículo |
| GET | `/fleet/expirations?days=` | COMPLIANCE_SUPERVISOR / ADMIN | Documentos por vencer / vencidos |

Todas protegidas por `InternalIdentityGuard` (+ `RolesGuard` donde aplica RBAC).

### gRPC `veo.fleet.v1.FleetService`

- `GetVehicle(GetByIdRequest) → VehicleReply`
- `GetDriverDocuments(GetByIdRequest) → DriverDocumentsReply` (lo usan identity/admin)

## Observabilidad

- `GET /api/v1/health` (liveness) · `GET /api/v1/health/ready` (readiness: postgres + redis)
- `GET /api/v1/metrics` (Prometheus) · OpenTelemetry (`bootstrapOtel`)
- Swagger en `/docs`

## Eventos

Ver [`docs/events.md`](docs/events.md). Publicados vía outbox → Kafka (topic `fleet`).

## Desarrollo

```bash
pnpm --filter @veo/fleet-service exec prisma generate
DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo pnpm --filter @veo/fleet-service exec prisma migrate deploy
pnpm --filter @veo/fleet-service typecheck
pnpm --filter @veo/fleet-service test
pnpm --filter @veo/fleet-service dev
```

### Entorno

- Postgres `postgresql://veo:veo_dev@localhost:5433/veo` (schema `fleet`)
- Redis `localhost:6379` · Kafka `localhost:9094`
