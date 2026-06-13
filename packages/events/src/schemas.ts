/**
 * Schemas Zod de los payloads de eventos de dominio + registro central.
 * Naming: `<domain>.<pastTense>`. Topic Kafka = `<domain>`. Key = id de la entidad raíz.
 *
 * Cada servicio es dueño de su dominio pero registra aquí el contrato del payload para que
 * los consumidores validen lo que reciben. Ampliar al implementar cada servicio.
 */
import { z } from 'zod';
import { PanicStatus, VehicleClass } from '@veo/shared-types';

const geo = z.object({ lat: z.number(), lon: z.number() });

/// Clase de vehículo del wire: DERIVADA del enum canónico `VehicleClass` de @veo/shared-types
/// (mini-lote "abrir el wire", gap 1 de la prueba de fuego del ADR 013). Una clase nueva en el enum
/// canónico ABRE estos schemas automáticamente; antes era un z.enum(['CAR','MOTO']) hardcodeado ×5 y
/// un evento con la clase nueva moría EN SILENCIO en el gate del consumer (kafka.ts safeParse → descarta).
const vehicleClassSchema = z.enum(Object.values(VehicleClass) as [VehicleClass, ...VehicleClass[]]);

/// Modo de pricing/despacho (ADR 011). Espeja PricingMode de @veo/shared-types (PUJA | FIXED, cerrado
/// y estable — a diferencia de la clase de vehículo, que es un eje de extensión del catálogo). Se
/// declara como enum local y se reutiliza en los eventos de pricing.
const pricingMode = z.enum(['PUJA', 'FIXED']);

/* ── identity ── */
export const userRegistered = z.object({ userId: z.string(), phone: z.string(), kycStatus: z.string() });
export const driverVerified = z.object({ driverId: z.string(), userId: z.string(), verifiedAt: z.string() });
/// El operador RECHAZÓ los antecedentes del conductor (espejo de driver.verified). identity-service lo
/// emite por OUTBOX en la MISMA tx que persiste Driver.backgroundCheckStatus=REJECTED + rejectionReason.
/// Downstream: audit (traza inmutable de la decisión) y admin-bff (proyecta el motivo en el read-model
/// para que el panel lo muestre). `reason` = motivo del rechazo (texto del operador); "" si no se dio uno
/// (degradación honesta, nunca un motivo falso). El conductor lo VE en la app (RejectedScreen) vía GET
/// /drivers/me, no por este evento. `rejectedAt` ISO-8601 del momento del rechazo.
export const driverRejected = z.object({ driverId: z.string(), userId: z.string(), reason: z.string(), rejectedAt: z.string() });
/// El operador SUSPENDIÓ manualmente al conductor desde el panel (acción admin, espejo de driver.rejected
/// pero del lado de la SUSPENSIÓN). identity-service lo emite por OUTBOX en la MISMA tx que el CAS de
/// `Driver.suspendedAt` (así nunca hay suspensión sin evento ni evento sin suspensión). Downstream:
/// audit-service (traza inmutable de la decisión) y admin-bff (proyecta status=SUSPENDED en el read-model
/// para que el panel lo refleje). Distinto de `fleet.driver_suspended` (suspensión AUTOMÁTICA por documento
/// crítico vencido, que emite fleet-service): este lo origina un operador. `reason` = motivo del operador
/// (texto libre, ""→honesto si no se dio). `suspendedAt` ISO-8601 del momento efectivo de la suspensión.
export const driverSuspended = z.object({ driverId: z.string(), reason: z.string(), suspendedAt: z.string() });
export const userKycVerified = z.object({ userId: z.string(), kycStatus: z.string(), verifiedAt: z.string() });
/// El usuario confirmó la titularidad de su correo (ADR-012, método correo+contraseña). identity-service
/// lo emite en la MISMA tx que marca el AuthMethod.emailVerified=true. Downstream: onboarding/CRM.
export const userEmailVerified = z.object({ userId: z.string(), email: z.string(), verifiedAt: z.string() });
export const biometricFailed = z.object({ driverId: z.string(), score: z.number(), attempt: z.number(), at: z.string() });
export const userDeletionRequested = z.object({ userId: z.string(), requestedAt: z.string(), graceUntil: z.string() });
/// Borrado EFECTIVO de la cuenta (BR-S06 derecho al olvido): el sweeper aplicó el tombstone vencida
/// la gracia. Señal de cascada para que los consumidores downstream purguen su PII del usuario.
/// `driverId` presente si el usuario tenía perfil de conductor. Distinto de user.deletion_requested
/// (que se emite al SOLICITAR el borrado, no al ejecutarlo).
export const userDeleted = z.object({ userId: z.string(), driverId: z.string().optional(), at: z.string() });
export const adminRoleChanged = z.object({ adminUserId: z.string(), roles: z.array(z.string()), changedBy: z.string(), at: z.string() });

/* ── referrals (identity) ── (Ola 2A) */
export const userReferred = z.object({
  referrerUserId: z.string(),
  referredUserId: z.string(),
  code: z.string(),
  at: z.string(),
});
export const referralRewarded = z.object({
  referrerUserId: z.string(),
  referredUserId: z.string(),
  /// Recompensa otorgada al referidor (céntimos PEN), modelada como crédito.
  rewardCents: z.number().int(),
  tripId: z.string(),
  at: z.string(),
});

/* ── trip ── (BR-T02 máquina de estados) */
export const tripRequested = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  origin: geo,
  destination: geo,
  fareCents: z.number().int(),
  childMode: z.boolean(),
  /// Ola 2B · tier moto-taxi: tipo de vehículo solicitado. dispatch filtra el matching por este
  /// valor (un viaje MOTO solo se ofrece a conductores MOTO). Opcional ⇒ default CAR en el consumidor.
  vehicleType: vehicleClassSchema.optional(),
  /// Ola 2B · viaje programado: marca que el viaje se activó desde el scheduler (reserva). dispatch
  /// puede incluirlo en la oferta como "reservado". Opcional.
  scheduled: z.boolean().optional(),
  /// Ola 2B · paradas intermedias ORDENADAS (máx 3). dispatch las recibe en el riel de eventos (no por
  /// join cross-servicio) para poder contemplarlas en el matching/oferta. Omitible por compat N-2 (= []).
  waypoints: z.array(geo).max(3).optional(),
});
export const tripAssigned = z.object({ tripId: z.string(), driverId: z.string(), vehicleId: z.string() });
/// `passengerId` ENRIQUECIDO (opcional, compat N-2): trip-service lo añade al outbox para que
/// notification-service resuelva el token del pasajero (push "tu conductor confirmó") sin un join
/// cross-servicio. Ausente en eventos viejos → el consumidor degrada honesto (omite el push).
export const tripAccepted = z.object({ tripId: z.string(), driverId: z.string(), etaSeconds: z.number().int(), passengerId: z.string().optional() });
export const tripArriving = z.object({ tripId: z.string(), driverId: z.string(), etaSeconds: z.number().int(), at: z.string(), passengerId: z.string().optional() });
/// `waitWindowSeconds` ENRIQUECIDO (opcional): ventana de espera del conductor en el punto de recojo
/// antes de poder cobrar penalidad/cancelar. notification-service la incluye en el push "tu conductor
/// llegó" si viaja. `passengerId` ídem accepted/arriving.
export const tripArrived = z.object({ tripId: z.string(), driverId: z.string(), at: z.string(), passengerId: z.string().optional(), waitWindowSeconds: z.number().int().optional() });
export const tripStarted = z.object({ tripId: z.string(), driverId: z.string(), startedAt: z.string(), passengerId: z.string().optional() });
export const tripCompleted = z.object({
  tripId: z.string(),
  fareCents: z.number().int(),
  distanceMeters: z.number(),
  durationSeconds: z.number().int(),
  driverId: z.string().optional(),
  passengerId: z.string().optional(),
  paymentMethod: z.enum(['YAPE', 'PLIN', 'CASH', 'CARD', 'PAGOEFECTIVO']).optional(),
  /// Código de promoción a canjear al cobrar (Ola 2A). Opcional. */
  promoCode: z.string().optional(),
  /// EFECTIVO · señal del CONDUCTOR al dar por terminado el viaje: "cobré el efectivo en mano"
  /// (driverConfirmed del modelo bilateral, BR-P03). DECISIÓN DEL DUEÑO: el efectivo se confirma al
  /// drop-off (ambos presentes), no después. Solo SIGNIFICATIVO si el viaje es CASH: payment-service
  /// crea la CashConfirmation con driverConfirmed=true de una (solo falta el pasajero). En métodos
  /// DIGITALES el flag se ignora (el cobro va por el riel). Ausente/false ⇒ flujo bilateral normal
  /// (el conductor confirmará por separado). Compat N-2: eventos viejos sin el campo ⇒ undefined.
  cashCollected: z.boolean().optional(),
});
export const tripCancelled = z.object({
  tripId: z.string(),
  by: z.enum(['PASSENGER', 'DRIVER', 'SYSTEM']),
  reason: z.string().optional(),
  penaltyCents: z.number().int().default(0),
  /// `driverId` ENRIQUECIDO (opcional, compat N-2): trip-service lo añade cuando había conductor asignado,
  /// para que payment-service compense al conductor que esperó (split de la penalidad, F2). Ausente → la
  /// penalidad va entera a la plataforma.
  driverId: z.string().optional(),
  /// `passengerId` ENRIQUECIDO (opcional, compat N-2): trip-service lo añade al outbox para que
  /// notification-service confirme HONESTO al pasajero ("cancelaste tu viaje" si by=PASSENGER; "tu
  /// conductor canceló" si by=DRIVER pre-recojo). NO se solapa con trip.reassigning: el cancel del
  /// conductor POST-accept emite reassigning (no cancelled). Ausente → el consumidor omite el push.
  passengerId: z.string().optional(),
});
/// BR-T07 modo niño (dominó S3): alguien intentó iniciar el viaje del hijo con un código INCORRECTO
/// (escenario impostor). `attempt` = nº de intento fallido dentro de la ventana de lockout (contador
/// Redis de trip-service, tope 5): la alerta al padre/madre distingue el 3er intento del 1ro.
/// OPCIONAL A PROPÓSITO (tolerancia de consumo, NO laxitud del producer): el relay del outbox publica
/// con `schema.parse` (lanza) y drena oldest-first dentro de UNA transacción (rollback ⇒ reintenta la
/// MISMA fila) — una fila pre-fix SIN `attempt` (backlog por Kafka caído / rolling deploy) sería un
/// poison pill que bloquea TODO el outbox de trip por head-of-line. El producer SIEMPRE lo emite hoy
/// (contrato cubierto por spec en trip-service); ausente ⇒ evento viejo y el consumidor degrada
/// honesto (alerta sin nº de intento).
/// `passengerId` ENRIQUECIDO (opcional, compat N-2): destinatario del push CRÍTICO (el padre/madre
/// dueño de la cuenta) sin join cross-servicio. Ausente → notification degrada honesto (omite el push).
export const tripChildCodeFailed = z.object({
  tripId: z.string(),
  driverId: z.string().optional(),
  passengerId: z.string().optional(),
  attempt: z.number().int().optional(),
  at: z.string(),
});
/// Watchdog (sweeper temporal): un viaje PRE-RECOJO se estancó (sin conductor / sin aceptación /
/// sin avanzar al recojo) más allá del umbral y se llevó a EXPIRED. Downstream: notificar al
/// pasajero; payment NO cobra (no hubo viaje). `fromStatus` = estado en que se estancó.
export const tripExpired = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  fromStatus: z.string(),
  /// Conductor asignado al momento de expirar, si lo había (ASSIGNED/ACCEPTED/ARRIVING/ARRIVED).
  driverId: z.string().optional(),
  /// Antigüedad de la última actividad (minutos) que disparó la expiración.
  staleMinutes: z.number().int(),
  at: z.string(),
});
/// Watchdog (sweeper temporal): un viaje EN CURSO (IN_PROGRESS) quedó abandonado (app del conductor
/// murió / nunca se cerró) más allá del umbral de holgura y se llevó a FAILED. Downstream: notificar
/// al pasajero; payment puede anular/omitir el cobro pendiente. `fromStatus` siempre IN_PROGRESS.
export const tripFailed = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  fromStatus: z.string(),
  driverId: z.string().optional(),
  /// Antigüedad de la última actividad (minutos) que disparó el fallo.
  staleMinutes: z.number().int(),
  at: z.string(),
});
/// PARADA negociada mid-trip (Lote C). El pasajero PROPONE una parada durante el viaje EN CURSO; el
/// server calcula el delta de tarifa y la tarifa nueva (server-authoritative). driver-bff lo reenvía al
/// CONDUCTOR en vivo (`waypoint:proposed`); notification-service lo pushea. `expiresAt` ISO para la cuenta
/// regresiva del cliente. El conductor debe responder antes del TTL.
export const tripWaypointProposed = z.object({
  proposalId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string(),
  point: geo,
  deltaFareCents: z.number().int(),
  newFareCents: z.number().int(),
  expiresAt: z.string(),
});
/// El conductor ACEPTÓ la parada: el waypoint ya se agregó al viaje y la tarifa se actualizó (delta
/// estampado server-side, MISMA transacción). public-bff lo reenvía al PASAJERO (`waypoint:outcome`).
export const tripWaypointAccepted = z.object({
  proposalId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string(),
  point: geo,
  deltaFareCents: z.number().int(),
  newFareCents: z.number().int(),
});
/// El conductor RECHAZÓ la parada: el viaje sigue igual (sin cambio de ruta ni tarifa). public-bff lo
/// reenvía al PASAJERO (`waypoint:outcome`).
export const tripWaypointRejected = z.object({
  proposalId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string(),
  point: geo,
});
/// La propuesta EXPIRÓ sin respuesta (TTL vencido, sweeper). Sin conductor en el payload (pudo no haber
/// respondido nunca). public-bff lo reenvía al PASAJERO (`waypoint:outcome`).
export const tripWaypointExpired = z.object({
  proposalId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  point: geo,
});
/// Derecho al olvido (BR-S06, Ley 29733) · señal per-viaje de la cascada de borrado. Al anonimizar
/// la PII de un viaje del usuario borrado (consumidor de `user.deleted`), trip-service emite UN
/// evento por viaje afectado. media-service lo consume para purgar el VIDEO DE CABINA de ese viaje
/// (recordings/segmentos en S3 + filas), que está indexado por `tripId` y NO se puede resolver desde
/// `user.deleted` sin un join cross-servicio prohibido. Idempotente: reprocesar es un no-op.
export const tripPiiErased = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  at: z.string(),
});

/* ── dispatch ── (BR-T06) */
export const dispatchMatchFound = z.object({ tripId: z.string(), driverId: z.string(), vehicleId: z.string().optional(), scoreMs: z.number() });
// `dispatch.offered` lo COMPARTEN dos flujos: el matcher FIXED (ofrece UN viaje concreto a un conductor) y
// el broadcast de PUJA (`offer-board.broadcast` difunde una puja abierta a los elegibles). Los campos de puja
// van OPCIONALES porque el camino FIXED emite SIN ellos; el conductor branchea por presencia de `bidCents`
// (presente ⇒ tarjeta de PUJA contraofertable; ausente ⇒ oferta FIXED a aceptar/rechazar). Mismos nombres que
// `OpenBidView` (GET /bids) — ambos derivan del MISMO OfferBoard, así el evento y el REST no divergen.
export const dispatchOffered = z.object({
  tripId: z.string(),
  driverId: z.string(),
  matchId: z.string(),
  expiresAt: z.string(),
  bidCents: z.number().int().positive().optional(),
  vehicleType: z.string().optional(),
  originLat: z.number().optional(),
  originLon: z.number().optional(),
  specialRequests: z.array(z.string()).optional(),
});

/* ── PUJA / negociación (ADR 010 §4) ── (Lote A: contratos)
 * Marketplace "proponé tu precio": el pasajero pone un bid (puja abierta), los conductores elegibles
 * responden con ofertas (aceptan el precio o contraofertan), y el pasajero elige UNA. dispatch es el
 * dueño de la negociación efímera (OfferBoard/Offer en Redis+TTL); trip sigue dueño del lifecycle.
 */

/// trip → dispatch. El pasajero abrió una puja: trip materializó REQUESTED (puja abierta) y publica el
/// bid para que dispatch abra el OfferBoard y haga broadcast a conductores elegibles. `bidCents` = piso
/// de la negociación (≥ floor de zona, validado en trip). `windowSec` = ventana de la puja (default 60s, §9).
export const tripBidPosted = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  bidCents: z.number().int().positive(),
  vehicleType: vehicleClassSchema,
  origin: geo,
  windowSec: z.number().int().positive(),
  /// H13 — secuencia MONOTÓNICA de negociación del viaje (NUNCA se resetea, a diferencia de
  /// reassignCount). Sella el ciclo de negociación que abrió este bid: dispatch la persiste en el board
  /// y la ESTAMPA en `dispatch.offer_accepted`, y trip-service la chequea al aplicar la tarifa para que
  /// una redelivery STALE de un offer_accepted de un ciclo VIEJO no escriba el precio equivocado.
  negotiationSeq: z.number().int().positive(),
  /// BE-2 · solicitudes especiales del pasajero (mascota/equipaje/silla). dispatch las guarda en el board
  /// para que el conductor las VEA antes de aceptar. Omitible por compat N-2 (default []).
  specialRequests: z.array(z.enum(['PET', 'LUGGAGE', 'CHILD_SEAT'])).optional(),
  /// #1 · `true` SOLO cuando este bid nace de la ACTIVACIÓN de una reserva (cron → activateScheduledTrip):
  /// el pasajero NO está en la app, así que notification-service le manda un push con deep-link al board.
  /// `false`/ausente en la puja inmediata o el rebid (el pasajero ya está mirando el board). Compat N-2.
  scheduled: z.boolean().optional(),
  /// Ola 2B · paradas intermedias ORDENADAS (máx 3). dispatch las recibe acá para el board/oferta sin
  /// join cross-servicio. Omitible por compat N-2 (= []).
  waypoints: z.array(geo).max(3).optional(),
});
/// dispatch → public-bff (pasajero). La respuesta de UN conductor elegible a un board. `kind` consolida
/// ambos casos del diseño: ACCEPT_PRICE (acepta el `bidCents` tal cual ⇒ `priceCents` == bid) y COUNTER
/// (contraoferta ⇒ `priceCents` > bid). CONSOLIDACIÓN (ADR 010 §4): este evento con `kind` REEMPLAZA al
/// `dispatch.offer_countered` que listaba el ADR — un evento de "contraoferta" aparte es redundante, el
/// COUNTER ya viaja acá. NO existe `dispatch.offer_countered`. `etaSeconds` = ETA del conductor al recojo.
export const dispatchOfferMade = z.object({
  tripId: z.string(),
  driverId: z.string(),
  kind: z.enum(['ACCEPT_PRICE', 'COUNTER']),
  priceCents: z.number().int().positive(),
  etaSeconds: z.number().int().nonnegative(),
});
/// dispatch (tras la elección del pasajero). El pasajero eligió la oferta de ESTE conductor; deriva el
/// `dispatch.match_found` que materializa ASSIGNED en trip. `priceCents` = precio acordado (pasa a ser el
/// `fareCents` del viaje). Las demás ofertas del board → LAPSED. Idempotente por (tripId, driverId).
export const dispatchOfferAccepted = z.object({
  tripId: z.string(),
  driverId: z.string(),
  priceCents: z.number().int().positive(),
  /// H13 — ciclo de negociación que produjo esta aceptación (eco del `negotiationSeq` que dispatch
  /// guardó en el board al abrirlo/re-abrirlo). trip-service lo exige en el `where` atómico de
  /// applyAgreedFare: una redelivery de un offer_accepted de un ciclo ANTERIOR (seq viejo) no matchea la
  /// fila vigente → no-op (no escribe la tarifa rancia del conductor del ciclo anterior).
  negotiationSeq: z.number().int().positive(),
});
/// dispatch → trip. dispatch NO encontró conductor → trip transiciona a EXPIRED (pantalla NoOffers, el
/// pasajero re-puja/re-pide). EVENTO UNIFICADO de "sin conductor" para AMBOS modos (cierre instantáneo,
/// no espera al watchdog). reasons: `window_expired` (PUJA: venció la ventana sin ofertas aceptadas),
/// `all_lapsed` (PUJA: todas las ofertas caducaron), `no_candidates` (FIXED: el matcher secuencial agotó
/// el k-ring sin candidatos). Reemplaza al viejo `dispatch.timeout` (que no tenía consumer → FIXED solo
/// cerraba por el watchdog en minutos).
export const dispatchNoOffers = z.object({
  tripId: z.string(),
  reason: z.enum(['window_expired', 'all_lapsed', 'no_candidates']),
});
/// dispatch → trip. El PASAJERO canceló la PUJA en curso (`POST /trips/:id/bid/cancel`): dispatch cerró el
/// board (OPEN→CANCELLED) y emite este evento de CIERRE por outbox para que trip transicione el VIAJE a
/// CANCELLED_BY_PASSENGER (no solo el board efímero). Cierra la asimetría con `dispatch.offer_accepted`: el
/// cancel también es event-driven con outbox transaccional, no un fire-and-forget que dejaba el trip zombie
/// en REQUESTED hasta el watchdog (~10min), bloqueando re-pedir (single-live-trip) y rompiendo accepts (409/404).
///
/// IDEMPOTENTE (cierre del caso "cancelo a los 95s, el board ya murió por TTL"): dispatch emite este evento
/// AUNQUE el board ya no exista en Redis — el VIAJE igual debe cerrarse. trip-service guard-ea por estado
/// (solo REQUESTED/REASSIGNING → CANCELLED_BY_PASSENGER), así una redelivery o un cancel repetido es no-op.
export const dispatchBidCancelled = z.object({
  tripId: z.string(),
  reason: z.literal('cancelled_by_passenger'),
});
/// dispatch → public-bff (pasajero). UNA oferta INDIVIDUAL del board dejó de ser válida con el board aún
/// ABIERTO: el conductor dejó de ser elegible (`stale`, BE-3) entre que ofertó y el pasajero la eligió.
/// El BFF lo reenvía como `offer:withdrawn` para que la app QUITE esa card al instante (sin esperar el
/// refetch). NO se emite al cerrar el board (eso ya lo cubren no_offers/match). Idempotente por (trip,driver).
export const dispatchOfferWithdrawn = z.object({
  tripId: z.string(),
  driverId: z.string(),
  reason: z.enum(['stale']),
});
/// trip → dispatch. El conductor canceló DESPUÉS de aceptar (pre-recojo): trip pasa a REASSIGNING y
/// re-abre el board (cierra el catastrófico #4 — no más pasajero abandonado). `bidCents` = bid con el que
/// se re-abre la puja; el pasajero PUEDE haberlo subido respecto del original.
///
/// ENRIQUECIDO (robustez #4): el board de Redis tiene TTL ~90s, pero el conductor puede cancelar minutos
/// después de aceptar — para entonces la key del board YA EXPIRÓ. dispatch NO puede depender del board
/// previo: este evento transporta TODO lo necesario para RECONSTRUIR el board desde cero (passengerId,
/// vehicleType, origin). `driverId` = el conductor que CANCELÓ, para que dispatch lo LIBERE del hot-index
/// (estaba markBusy y quedaría excluido del matching para siempre) y vuelva a ser elegible.
export const tripReassigning = z.object({
  tripId: z.string(),
  /// Conductor que canceló (se libera en dispatch: markAvailable / hot-index release).
  driverId: z.string(),
  /// Pasajero del viaje (para reconstruir el board sin depender de la key vieja de Redis).
  passengerId: z.string(),
  /// Tipo de vehículo del viaje: dispatch difunde la re-puja solo a conductores de ese tipo.
  vehicleType: vehicleClassSchema,
  /// Origen del viaje (geo): centro del broadcast a conductores elegibles cercanos.
  origin: geo,
  bidCents: z.number().int().positive(),
  reason: z.enum(['driver_cancelled']),
  /// H13 — secuencia MONOTÓNICA del NUEVO ciclo de negociación que abre esta reasignación (trip la
  /// incrementó al pasar a REASSIGNING). dispatch la guarda en el board re-abierto y la estampa en el
  /// `dispatch.offer_accepted` del re-match, cerrando la ventana a redeliveries del ciclo anterior.
  negotiationSeq: z.number().int().positive(),
});

/* ── pricing ── (ADR 011 · switch PUJA↔FIJO controlado por admin) */

/// admin-bff → trip-service. El ADMIN editó el schedule de modo de pricing y emite el SNAPSHOT
/// COMPLETO (no un delta): trip-service REEMPLAZA su proyección local entera (read-model), lo que la
/// hace idempotente —reprocesar el mismo snapshot deja el mismo estado—. `defaultMode` gana cuando
/// ninguna regla matchea (degradación honesta: sin proyección → defaultMode, decisión §8.2 = PUJA).
/// `version` es MONOTÓNICA (la proyección descarta un snapshot con version ≤ a la ya aplicada, para
/// tolerar el reordenamiento at-least-once de Kafka). `rules`: la PRIMERA que matchea (día, minuto)
/// gana; orden de evaluación = orden del array.
export const pricingModeScheduleUpdated = z.object({
  /// Modo aplicado cuando ninguna regla matchea (§8.2 default = PUJA).
  defaultMode: pricingMode,
  /// Reglas horarias evaluadas en orden; la primera que matchea (día, minuto-del-día) gana.
  rules: z.array(
    z.object({
      /// Bitmask de días de la semana (Lun=1, Mar=2, Mié=4, …, Dom=64). 1..127 (al menos un día).
      dayMask: z.number().int().min(1).max(127),
      /// Inicio del rango horario, minuto del día en hora local de Lima (0..1439, inclusive).
      startMinute: z.number().int().min(0).max(1439),
      /// Fin del rango horario, minuto del día en hora local de Lima (0..1439, inclusive).
      endMinute: z.number().int().min(0).max(1439),
      /// Modo que fuerza esta regla (PUJA | FIXED).
      mode: pricingMode,
    }),
  ),
  /// Versión MONOTÓNICA del schedule (ordenamiento de eventos stale: la proyección ignora version ≤ vigente).
  version: z.number().int().nonnegative(),
  /// Marca ISO de cuándo el admin guardó el snapshot.
  updatedAt: z.string(),
});

/* ── tracking ── */
export const driverLocationUpdated = z.object({
  driverId: z.string(),
  point: geo,
  h3: z.string(),
  at: z.string(),
  /// Rumbo del conductor en grados [0,360). Lo emite la app (GPS nativo) y el public-bff lo reenvía al
  /// pasajero/familia para ROTAR el ícono del vehículo en el mapa. Opcional/nullable por compat con
  /// pings antiguos y muestras sin rumbo (vehículo detenido) ⇒ el cliente no rota.
  heading: z.number().min(0).max(360).nullable().optional(),
  /// Ola 2B · tier moto-taxi: tipo de vehículo activo del conductor. dispatch lo proyecta en el hot
  /// index para filtrar el matching por tipo. Opcional por compat (pings antiguos) ⇒ default CAR.
  vehicleType: vehicleClassSchema.optional(),
});
export const driverEnteredZone = z.object({ driverId: z.string(), zoneId: z.string(), at: z.string() });

/* ── media ── (BR-S01 cámara) */
export const mediaRecordingStarted = z.object({ tripId: z.string(), roomName: z.string(), startedAt: z.string() });
export const mediaArchived = z.object({ tripId: z.string(), s3Key: z.string(), bytes: z.number().int(), retentionDays: z.number().int() });
export const mediaAccessGranted = z.object({
  requestId: z.string(),
  tripId: z.string(),
  segmentId: z.string().optional(),
  operatorId: z.string(),
  approvedBy: z.string(),
  watermark: z.string().optional(),
  expiresAt: z.string(),
  at: z.string(),
});

/* ── payment ── (BR-P01) */
export const paymentCaptured = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  method: z.enum(['YAPE', 'PLIN', 'CASH', 'CARD', 'PAGOEFECTIVO']),
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  /// `passengerId` ENRIQUECIDO (opcional, compat N-2): payment-service lo persiste en la fila Payment
  /// (lo recibe del trip.completed que dispara el cobro) y lo añade al outbox para que
  /// notification-service mande el push "pago confirmado · S/X.XX" al pasajero. Ausente → omite el push.
  passengerId: z.string().optional(),
});
export const paymentFailed = z.object({ paymentId: z.string(), tripId: z.string(), reason: z.string(), willRetry: z.boolean() });
/// PROPINA añadida a un viaje YA cobrado (BR-P04): el 100% va al CONDUCTOR, fuera de comisión.
/// payment-service la emite por OUTBOX desde `addTip` (en la MISMA transacción que el incremento de
/// `tipCents`, así nunca hay propina sumada sin evento ni evento sin propina). El driver-bff la consume
/// para empujar al CONDUCTOR "recibiste una propina de S/X" en vivo. `driverId` ENRIQUECIDO (opcional,
/// compat N-2): destino del push sin join cross-servicio; ausente ⇒ el consumidor lo resuelve por
/// `tripId`. `tipCents` = monto de la propina (céntimos, entero positivo).
export const paymentTipAdded = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  driverId: z.string().optional(),
  tipCents: z.number().int(),
});
/// EFECTIVO bilateral (BR-P03) · se creó un Payment CASH que YA tiene la confirmación del CONDUCTOR
/// (cobró en mano al terminar, driverConfirmed=true) y queda PENDING esperando SOLO la confirmación del
/// PASAJERO para capturarse. payment-service lo emite por OUTBOX desde el cobro disparado por
/// trip.completed (cuando `cashCollected=true`). notification-service lo consume para empujar al
/// PASAJERO "confirma tu pago en efectivo de S/X". El CONDUCTOR no necesita push (ya confirmó al
/// terminar). `passengerId` ENRIQUECIDO (opcional): destino del push sin join cross-servicio; ausente
/// ⇒ el consumidor degrada honesto (omite el push). `grossCents` = monto a confirmar (S/ del recibo).
export const paymentCashPending = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  grossCents: z.number().int(),
  passengerId: z.string().optional(),
});
export const paymentRefunded = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  amountCents: z.number().int(),
  reason: z.string().optional(),
  approvedBy: z.string(),
  /// `passengerId` ENRIQUECIDO (opcional): payment-service lo añade al outbox (de la fila Payment) para
  /// que notification-service mande el push "te devolvimos S/X.XX" al pasajero. Ausente → omite el push.
  passengerId: z.string().optional(),
});
/// Penalidad de cancelación REGISTRADA (F2): el pasajero canceló y payment-service la guarda como
/// obligación PENDING con el split conductor/plataforma. notification avisa al pasajero ("te cobramos
/// S/X por cancelar"). El conductor cobra `driverCompensationCents` en su payout cuando se salda.
export const cancellationPenaltyRecorded = z.object({
  penaltyId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string().optional(),
  penaltyCents: z.number().int(),
  driverCompensationCents: z.number().int(),
  platformCents: z.number().int(),
});
/// Penalidad de cancelación SALDADA (F2.3): el pasajero la pagó por el rail (Payment de liquidación
/// capturado). El gate de nuevos viajes se libera y `driverCompensationCents` entra al payout del
/// conductor. notification avisa al pasajero ("pagaste la penalidad") y, si hubo conductor, su parte.
export const cancellationPenaltyCollected = z.object({
  penaltyId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string().optional(),
  penaltyCents: z.number().int(),
  driverCompensationCents: z.number().int(),
  platformCents: z.number().int(),
  /// id del Payment de liquidación que saldó la penalidad (para conciliación/auditoría).
  settlementPaymentId: z.string(),
});

export const payoutProcessed = z.object({ payoutId: z.string(), driverId: z.string(), amountCents: z.number().int(), period: z.string() });

/* ── afiliación de wallet / Yape On File (payment) ── (Ola pagos PE)
 * Notificaciones futuras (push "tu Yape quedó afiliado"). SIN PII: solo ids + phone enmascarado. */
export const paymentAffiliationActivated = z.object({
  affiliationId: z.string(),
  userId: z.string(),
  wallet: z.enum(['YAPE']),
  /// Teléfono enmascarado (nunca el número completo).
  phoneMasked: z.string().optional(),
  at: z.string(),
});
export const paymentAffiliationExpired = z.object({
  affiliationId: z.string(),
  userId: z.string(),
  wallet: z.enum(['YAPE']),
  at: z.string(),
});

/* ── promos / cupones (payment) ── (Ola 2A) */
export const promoRedeemed = z.object({
  promotionId: z.string(),
  code: z.string(),
  userId: z.string(),
  tripId: z.string(),
  discountCents: z.number().int(),
  at: z.string(),
});

/* ── incentivos al conductor (payment) ── (Ola 2C) */
export const incentiveCompleted = z.object({
  incentiveId: z.string(),
  driverId: z.string(),
  /// Recompensa otorgada al conductor (céntimos PEN), modelada como crédito/bono.
  rewardCents: z.number().int(),
  tripsCompleted: z.number().int(),
  at: z.string(),
});

/* ── panic ── (BR-S04/S05, flujo §06) */
export const panicTriggered = z.object({
  panicId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  geo,
  dedupKey: z.string(),
  triggeredAt: z.string(),
  evidenceS3Keys: z.array(z.string()).optional(),
});
/// El operador de la central RECONOCIÓ la alerta (TRIGGERED→ACKNOWLEDGED). panic-service lo emite por
/// OUTBOX en la MISMA tx que el CAS de estado (detrás de RolesGuard + PANIC_OPERATORS: el agresor NO
/// puede forjarlo). `tripId` + `passengerId` ENRIQUECIDOS desde la fila PanicEvent (siempre presentes,
/// no compat N-2: panic-service los tiene): notification-service los usa para pushear al PASAJERO
/// "la central vio tu alerta y está respondiendo" sin un join cross-servicio.
export const panicAcknowledged = z.object({
  panicId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  operatorId: z.string(),
  ackAt: z.string(),
});
/// El operador CERRÓ la alerta (→RESOLVED | FALSE_ALARM). panic-service lo emite por OUTBOX en la MISMA
/// tx que el CAS de cierre (RolesGuard + PANIC_OPERATORS: no forjable por el agresor — base de seguridad
/// del fix del dominó). `status` TIPADO al enum canónico `PanicStatus` (solo los dos estados de cierre):
/// rechaza cualquier string fuera del enum (cero strings mágicos). DESENMASCARADO CONDICIONAL (decisión
/// del dueño, conservadora): share-service restaura la vista familiar SOLO si `FALSE_ALARM`; si `RESOLVED`
/// (emergencia real atendida) MANTIENE la máscara —el enlace pudo ser capturado por el agresor—.
/// `tripId` + `passengerId` ENRIQUECIDOS desde la fila PanicEvent: share-service mapea por `tripId`,
/// notification pushea al `passengerId` "tu alerta fue cerrada" (SIEMPRE, en ambos status).
export const panicResolved = z.object({
  panicId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  /// Solo los dos estados de CIERRE del enum canónico (no TRIGGERED/ACKNOWLEDGED): el contrato falla-cerrado.
  status: z.enum([PanicStatus.RESOLVED, PanicStatus.FALSE_ALARM]),
  resolvedBy: z.string(),
  at: z.string(),
});
/**
 * panic.fanout_requested (BR-S05, fix de durabilidad del SMS de pánico): share-service ya creó el
 * enlace de seguimiento y DELEGA el fan-out durable de SMS a notification-service (engine con
 * retry/backoff/SMPP). notification resuelve los teléfonos+nombres por gRPC GetTrustedContacts.
 *
 * SOBERANÍA (FOUNDATION §0.7): SOLO IDs + el deep-link (URL permitida). CERO PII en el payload:
 * ningún teléfono ni nombre viaja por Kafka. `.strict()` RECHAZA cualquier campo extra (p. ej. un
 * `phone` filtrado) — el contrato falla-cerrado contra fugas de PII, verificado por test.
 */
export const panicFanoutRequested = z
  .object({
    panicId: z.string(),
    tripId: z.string(),
    passengerId: z.string(),
    geo,
    /** IDs de los contactos de confianza a notificar; notification resuelve sus teléfonos por gRPC. */
    contactIds: z.array(z.string()),
    /** Deep-link público de seguimiento (family-web). Permitido: es un enlace, no PII de la persona. */
    shareLink: z.string(),
  })
  .strict();

/* ── notification ── */
/** Honesto: el RIEL (FCM/APNs/SMS…) ACEPTÓ el mensaje. NO garantiza recepción en el device. */
export const notificationSent = z.object({ notificationId: z.string(), channel: z.enum(['PUSH', 'SMS', 'EMAIL', 'WEBHOOK']), to: z.string() });
/** Reservado para entrega REAL confirmada por receipt (FCM BigQuery export / futuro). Hoy NO se emite. */
export const notificationDelivered = z.object({ notificationId: z.string(), channel: z.enum(['PUSH', 'SMS', 'EMAIL', 'WEBHOOK']), to: z.string() });
export const notificationFailed = z.object({ notificationId: z.string(), channel: z.string(), error: z.string() });

/* ── rating ── (BR-D01 / BR-I05) */
export const ratingCreated = z.object({ ratingId: z.string(), tripId: z.string(), driverId: z.string(), stars: z.number().int().min(1).max(5) });
export const driverFlagged = z.object({ driverId: z.string(), rollingAvg: z.number(), reason: z.string() });
export const passengerFlagged = z.object({ passengerId: z.string(), rollingAvg: z.number(), reason: z.string() });

/* ── share ── (pilar 4) */
export const shareLinkGenerated = z.object({ shareId: z.string(), tripId: z.string(), expiresAt: z.string() });
export const shareViewed = z.object({ shareId: z.string(), at: z.string() });

/* ── chat ── (Ola 2A: chat in-app conductor↔pasajero) */
export const chatMessageSent = z.object({
  messageId: z.string(),
  tripId: z.string(),
  senderId: z.string(),
  senderRole: z.enum(['PASSENGER', 'DRIVER']),
  body: z.string(),
  createdAt: z.string(),
  /// `passengerId` ENRIQUECIDO (opcional): el BFF lo conoce (gRPC GetTrip) y lo propaga a chat-service.
  /// notification-service lo usa para mandar push al PASAJERO cuando el conductor escribe (senderRole=DRIVER),
  /// dedup por messageId. NO hay presencia (online/offline) en el sistema: el push se manda SIEMPRE
  /// (decisión MINIMAL; el caso "avisar al conductor" queda como decisión de producto pendiente).
  passengerId: z.string().optional(),
});

/* ── audit ── (BR-S03 trazabilidad inmutable) */
export const auditRecorded = z.object({
  entryId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  actorId: z.string().optional(),
  at: z.string(),
});

/* ── fleet ── (gestión de flota / documentos) */
export const fleetDocumentExpiring = z.object({
  documentId: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  documentType: z.string(),
  expiresAt: z.string(),
  daysRemaining: z.number().int(),
  /** Hito de alerta alcanzado (30/15/7/1). */
  milestone: z.number().int(),
});
export const fleetDocumentExpired = z.object({
  documentId: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  documentType: z.string(),
  expiresAt: z.string(),
  critical: z.boolean(),
});
export const fleetDriverSuspended = z.object({ driverId: z.string(), reason: z.string(), documentId: z.string().optional(), documentType: z.string().optional(), suspendedAt: z.string() });
export const fleetVehicleSuspended = z.object({ vehicleId: z.string(), reason: z.string(), suspendedAt: z.string() });
export const fleetVehicleRegistered = z.object({
  vehicleId: z.string(),
  driverId: z.string(),
  plate: z.string(),
  vehicleType: vehicleClassSchema,
  registeredAt: z.string(),
});

/** Registro central: eventType → schema del payload. */
export const EVENT_SCHEMAS = {
  'user.registered': userRegistered,
  'user.email_verified': userEmailVerified,
  'user.kyc_verified': userKycVerified,
  'user.deletion_requested': userDeletionRequested,
  'user.deleted': userDeleted,
  'admin.role_changed': adminRoleChanged,
  'driver.verified': driverVerified,
  'driver.rejected': driverRejected,
  'driver.suspended': driverSuspended,
  'biometric.failed': biometricFailed,
  'user.referred': userReferred,
  'referral.rewarded': referralRewarded,
  'trip.requested': tripRequested,
  'trip.assigned': tripAssigned,
  'trip.accepted': tripAccepted,
  'trip.arriving': tripArriving,
  'trip.arrived': tripArrived,
  'trip.started': tripStarted,
  'trip.completed': tripCompleted,
  'trip.cancelled': tripCancelled,
  'trip.child_code_failed': tripChildCodeFailed,
  'trip.expired': tripExpired,
  'trip.failed': tripFailed,
  'trip.pii_erased': tripPiiErased,
  'trip.bid_posted': tripBidPosted,
  'trip.reassigning': tripReassigning,
  'trip.waypoint_proposed': tripWaypointProposed,
  'trip.waypoint_accepted': tripWaypointAccepted,
  'trip.waypoint_rejected': tripWaypointRejected,
  'trip.waypoint_expired': tripWaypointExpired,
  'dispatch.match_found': dispatchMatchFound,
  'dispatch.offered': dispatchOffered,
  'dispatch.offer_made': dispatchOfferMade,
  'dispatch.offer_accepted': dispatchOfferAccepted,
  'dispatch.no_offers': dispatchNoOffers,
  'dispatch.bid_cancelled': dispatchBidCancelled,
  'dispatch.offer_withdrawn': dispatchOfferWithdrawn,
  'pricing.mode_schedule_updated': pricingModeScheduleUpdated,
  'driver.location_updated': driverLocationUpdated,
  'driver.entered_zone': driverEnteredZone,
  'media.recording_started': mediaRecordingStarted,
  'media.archived': mediaArchived,
  'media.access_granted': mediaAccessGranted,
  'payment.captured': paymentCaptured,
  'payment.failed': paymentFailed,
  'payment.tip_added': paymentTipAdded,
  'payment.cash_pending': paymentCashPending,
  'payment.refunded': paymentRefunded,
  'payment.cancellation_penalty_recorded': cancellationPenaltyRecorded,
  'payment.cancellation_penalty_collected': cancellationPenaltyCollected,
  'payment.affiliation_activated': paymentAffiliationActivated,
  'payment.affiliation_expired': paymentAffiliationExpired,
  'payout.processed': payoutProcessed,
  'promo.redeemed': promoRedeemed,
  'incentive.completed': incentiveCompleted,
  'panic.triggered': panicTriggered,
  'panic.fanout_requested': panicFanoutRequested,
  'panic.acknowledged': panicAcknowledged,
  'panic.resolved': panicResolved,
  'notification.sent': notificationSent,
  'notification.delivered': notificationDelivered,
  'notification.failed': notificationFailed,
  'rating.created': ratingCreated,
  'driver.flagged': driverFlagged,
  'passenger.flagged': passengerFlagged,
  'share.link_generated': shareLinkGenerated,
  'share.viewed': shareViewed,
  'chat.message_sent': chatMessageSent,
  'audit.recorded': auditRecorded,
  'fleet.document_expiring': fleetDocumentExpiring,
  'fleet.document_expired': fleetDocumentExpired,
  'fleet.driver_suspended': fleetDriverSuspended,
  'fleet.vehicle_suspended': fleetVehicleSuspended,
  'fleet.vehicle_registered': fleetVehicleRegistered,
} as const satisfies Record<string, z.ZodType>;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;

/** Topic Kafka para un eventType: el dominio antes del punto. */
export function topicForEvent(eventType: string): string {
  const domain = eventType.split('.')[0];
  // driver.* eventos los emite tracking/identity pero comparten topic 'driver'
  return domain ?? 'misc';
}

export function schemaForEvent(eventType: string): z.ZodType | undefined {
  return (EVENT_SCHEMAS as Record<string, z.ZodType>)[eventType];
}
