# Eventos de `payment-service`

Topic Kafka = dominio antes del punto (`payment`, `payout`). Key = id de la entidad raíz.
Todo evento de salida se publica vía **OUTBOX** (misma transacción que la mutación) y lo drena el relay.

## Publica

| Topic     | Event              | Schema (payload)                                             | Disparado por                                                                                          | Consumidores                                                     |
| --------- | ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `payment` | `payment.captured` | `{ paymentId, tripId, method, grossCents, commissionCents }` | Captura Yape/Plin (BR-P02) o efectivo confirmado (BR-P03)                                              | trip-service, rating-service, finanzas                           |
| `payment` | `payment.failed`   | `{ paymentId, tripId, reason, willRetry }`                   | DEBT tras 3 fallos (`willRetry=false`, BR-P02) y discrepancia de efectivo (`CASH_DISCREPANCY`, BR-P03) | trip-service (bloqueo de nuevos viajes), soporte, alerta central |
| `payout`  | `payout.processed` | `{ payoutId, driverId, amountCents, period }`                | Liquidación semanal procesada (BR-P05)                                                                 | notification-service, finanzas                                   |

## Consume

| Topic    | Event            | Acción                                                     | Idempotencia / Reintentos                                             |
| -------- | ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `trip`   | `trip.completed` | Cobra el viaje (BR-P01) vía `PaymentsService.charge`       | `dedupKey = trip-completed:<tripId>` + UNIQUE → reprocesar no duplica |
| `driver` | `driver.flagged` | Retiene los payouts del conductor en review (HELD, BR-P05) | Idempotente (set en Redis)                                            |

## Notas de contrato (gaps para el equipo de plataforma)

- `trip.completed` no incluye `driverId` ni el método/instrumento de pago del pasajero. El cobro
  por evento usa `DEFAULT_PAYMENT_METHOD` y deja `driverId` nulo; el camino preciso es el REST
  `POST /payments/charge` (el BFF aporta `method`, `payerRef`, `driverId`). Para payouts por
  conductor se requiere `driverId` en el cobro (hoy vía REST). **Propuesta:** añadir `driverId` y
  `payerRef`/método al schema `trip.completed` o exponer un lookup gRPC trip→driver.
- No existe schema de evento para reembolsos. El reembolso (BR-P06) cambia el estado en DB
  (`CAPTURED → REFUNDED`) sin emitir evento Kafka. **Propuesta:** registrar `payment.refunded`
  en `@veo/events` si finanzas/contabilidad lo necesitan.
