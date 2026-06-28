# payment-service

Cobros (Yape/Plin/efectivo/tarjeta), comisión de plataforma, payouts a conductores, reembolsos,
confirmación bilateral de efectivo y conciliación contra extractos del riel · VEO (movilidad segura, Lima).

- **HTTP**: `:3005` · prefijo `/api/v1` · Swagger en `/docs`
- **gRPC**: `0.0.0.0:50055` · paquete `veo.payment.v1` (`GetPayment`)
- **Sondas**: `GET /health`, `GET /health/ready`, métricas Prometheus en `GET /metrics`
- **Dinero**: SIEMPRE en céntimos PEN (enteros) vía `@veo/utils` (`money`, `commission`, `addMoney`).
- **IDs**: UUIDv7 (`@veo/utils`). **Errores**: `DomainError` (`ConflictError` para idempotencia).
- **Eventos**: OUTBOX → Kafka (misma transacción). Ver [`docs/events.md`](docs/events.md).

## Arquitectura (igual plantilla que `identity-service`)

```
src/
  main.ts                      bootstrap (OTel, helmet, ValidationPipe, Swagger, gRPC)
  app.module.ts                ConfigModule.validate, ScheduleModule, Core, features, Health/Metrics, READINESS_CHECKS
  config/env.schema.ts         validación de entorno (zod)
  infra/                       core.module, prisma.service (ReadWriteClient), redis, outbox.relay (drainOutbox)
  ports/gateway/               PUERTO PaymentGateway + adapters live | sandbox (VEO_PAYMENT_MODE)
  payments/                    policy (pura) + service + controller + dto
  payouts/                     policy (pura) + service (cron lunes) + controller + dto
  reconciliation/              service (cron diario 04:00)
  events/                      consumidores Kafka (trip.completed, driver.flagged)
  grpc/                        PaymentService.GetPayment
prisma/schema.prisma           multiSchema schemas=["payment"], OutboxEvent
proto/payment.proto            veo.payment.v1
```

## Reglas de negocio

| Regla        | Descripción                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| BR-P01       | El cobro ocurre al COMPLETED (consume `trip.completed`). Pre-auth de tarjeta es fase 4 (deshabilitado).                           |
| Idempotencia | Cada cobro lleva `dedupKey` (UNIQUE). El segundo intento devuelve el mismo pago, sin recobrar.                                    |
| BR-P02       | Yape/Plin: 3 reintentos con backoff exponencial; si fallan → `DEBT` + `payment.failed (willRetry=false)`.                         |
| BR-P03       | Efectivo: confirmación bilateral (driver + pasajero). Disputa → evento de discrepancia (soporte).                                 |
| BR-P04       | Comisión (take rate `COMMISSION_RATE`, default 20%) sobre el **bruto** (incluye surge, **excluye** propinas). `feeCents` visible. |
| BR-P05       | Payouts semanales (lunes), mínimo S/50; retención `HELD` si el conductor está en review (`driver.flagged`).                       |
| BR-P06       | Reembolsos (finance:refund): ventana 7 días; FINANCE/ADMIN/SUPERADMIN; monto alto (>umbral, default S/300) requiere ADMIN/SUPERADMIN (dual-control). Idempotente: dedupKey + backstop por ventana sobre (pago, monto). |
| BR-P07       | Conciliación diaria 04:00 contra el extracto del riel; discrepancia > 1% → alerta a finanzas.                                     |

## El riel externo tras un puerto propio

Yape/Plin es el único componente externo inevitable. Se encapsula tras el puerto `PaymentGateway`:

- `VEO_PAYMENT_MODE=live` → `LivePaymentGateway` (API directa del proveedor, sin SaaS intermediario).
- `VEO_PAYMENT_MODE=sandbox` (default) → `SandboxPaymentGateway`: red determinista en proceso que
  confirma tras un delay y lleva su propio libro mayor para conciliación. **No es un mock de test**:
  es un adapter real seleccionable. Declina de forma determinista los `payerRef` que terminan en
  `SANDBOX_DECLINE_SUFFIX` (default `0000`) para ejercer el camino de DEBT sin cuentas reales.

## Endpoints REST (`/api/v1`)

| Método | Ruta                         | Auth                                             | Descripción                                                     |
| ------ | ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| POST   | `/payments/charge`           | Internal                                         | Cobro idempotente (body `dedupKey`).                            |
| GET    | `/payments/:id`              | Internal                                         | Obtener un pago.                                                |
| POST   | `/payments/:id/cash/confirm` | Internal                                         | Confirmación bilateral de efectivo (`party=driver\|passenger`). |
| POST   | `/payments/:tripId/refund`   | Internal + RBAC (FINANCE/ADMIN/SUPERADMIN)       | Reembolso (monto alto >umbral requiere ADMIN/SUPERADMIN).       |
| GET    | `/payouts?driverId=`         | Internal                                         | Listar payouts de un conductor.                                 |
| POST   | `/payouts/run`               | Internal + RBAC FINANCE + step-up MFA si >S/5000 | Correr la liquidación.                                          |

## Desarrollo

```bash
# Cliente Prisma
pnpm --filter @veo/payment-service exec prisma generate

# Migración (DB local schema payment)
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo" pnpm --filter @veo/payment-service exec prisma migrate deploy

# Verificación
pnpm --filter @veo/payment-service typecheck
pnpm --filter @veo/payment-service test   # unit + e2e (testcontainers Postgres real)
```

### Entorno

- DB `postgresql://veo:veo_dev@localhost:5433/veo` (schema `payment`) · Redis `localhost:6379` · Kafka `localhost:9094`.
- Variables clave: `VEO_PAYMENT_MODE`, `COMMISSION_RATE`, `PAYMENT_MAX_RETRIES`, `PAYMENT_RETRY_BASE_MS`,
  `PAYOUT_MIN_CENTS`, `PAYOUT_STEPUP_CENTS`, `REFUND_WINDOW_DAYS`, `REFUND_L2_THRESHOLD_CENTS`,
  `RECONCILIATION_ALERT_PCT`. Ver `src/config/env.schema.ts`.
