# Eventos de `dispatch-service`

Todos los eventos viajan en el envelope estándar de `@veo/events` y se publican vía **outbox**
(misma transacción Postgres que la mutación de dominio) → relay → Kafka.

## Publica

| Topic (eventType)      | Schema (`@veo/events`)          | Disparado por                              | Consumidores |
| ---------------------- | ------------------------------- | ------------------------------------------ | ------------ |
| `dispatch.match_found` | `{ tripId, driverId, scoreMs }` | `DispatchService.accept` (oferta aceptada) | trip-service |
| `dispatch.timeout`     | `{ tripId, attemptedDrivers }`  | `MatchingService` (candidatos agotados)    | trip-service |

> `scoreMs` = latencia oferta→aceptación en ms (proxy de tiempo de asignación).

## Consume

| Topic (eventType)         | Acción                                                                                | Reintentos                         |
| ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- |
| `trip.requested`          | Registra demanda surge y lanza el matching (k-ring + scoring + oferta secuencial).    | Kafka (groupId `dispatch-service`) |
| `driver.location_updated` | Actualiza el hot index Redis (ubicación + celda H3, mueve de celda con LUA atómico).  | Kafka                              |
| `panic.triggered`         | Excluye al conductor del viaje en pánico del pool de ofertas (sin reasignación auto). | Kafka                              |
| `rating.created`          | Proyección local `driver_stats`: media móvil del rating.                              | Kafka                              |
| `driver.flagged`          | Proyección local: rating promedio impuesto (`rollingAvg`).                            | Kafka                              |
| `trip.completed`          | Proyección (último viaje) + reincorpora al conductor al pool disponible.              | Kafka                              |
| `trip.cancelled`          | Proyección de cancelación del conductor (solo `by = DRIVER`).                         | Kafka                              |

## Decisiones de contrato

- **Datos de scoring por proyección local, NO join cross-servicio.** `rating`, `último viaje` y
  `cancellationRate` se mantienen en la tabla `driver_stats` poblada por eventos. dispatch nunca
  consulta tablas de identity/rating. (Si en el futuro se exponen por gRPC, se puede sustituir la
  fuente sin tocar el dominio gracias a `DriverProjectionService`.)
- **`driver.location_updated` no incluye `status`.** Se asume que tracking-service solo emite pings
  de conductores en turno; dispatch trata cada ping como disponible y saca del pool al asignar
  (`markBusy`) y reincorpora en `trip.completed` (`markAvailable`). El TTL del registro de ubicación
  (env `DRIVER_LOC_TTL_SECONDS`, 60s) descarta conductores que dejan de pinguear.
- **`trip.completed` no incluye `driverId`.** Se resuelve vía el `dispatch_matches` ACCEPTED del viaje.

## Gaps de contrato compartido (no cubiertos por `@veo/events`)

- **Notificación de oferta al conductor.** No existe `dispatch.offer_*` para empujar la oferta vía
  notification-service. Hoy la fila `dispatch_matches` en estado `OFFERED` + `GetMatch` gRPC son el
  mecanismo; `OfferDelivery` está listo para enchufar el push cuando se defina el contrato.
- **Resolución de pánico.** No hay `panic.resolved` en el registro de eventos; la exclusión se limpia
  con `ExclusionRegistry.clear` (acción de ops) hasta que exista el evento.
