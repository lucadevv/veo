/**
 * Schemas Zod de los payloads de eventos de dominio + registro central.
 * Naming: `<domain>.<pastTense>`. Topic Kafka = `<domain>`. Key = id de la entidad raíz.
 *
 * Cada servicio es dueño de su dominio pero registra aquí el contrato del payload para que
 * los consumidores validen lo que reciben. Ampliar al implementar cada servicio.
 */
import { z } from 'zod';
import { FleetDocumentType, PanicStatus, VehicleClass, VehicleSegment } from '@veo/shared-types';

const geo = z.object({ lat: z.number(), lon: z.number() });

/// Clase de vehículo del wire: DERIVADA del enum canónico `VehicleClass` de @veo/shared-types
/// (mini-lote "abrir el wire", gap 1 de la prueba de fuego del ADR 013). Una clase nueva en el enum
/// canónico ABRE estos schemas automáticamente; antes era un z.enum(['CAR','MOTO']) hardcodeado ×5 y
/// un evento con la clase nueva moría EN SILENCIO en el gate del consumer (kafka.ts safeParse → descarta).
const vehicleClassSchema = z.enum(Object.values(VehicleClass) as [VehicleClass, ...VehicleClass[]]);
/// Segmento del vehículo (B5-3) derivado del enum canónico VehicleSegment. Viaja en el ping de ubicación
/// para que dispatch filtre la eligibilidad por oferta (confort exige ≥ MID) sin consultar fleet en el hot-path.
const vehicleSegmentSchema = z.enum(
  Object.values(VehicleSegment) as [VehicleSegment, ...VehicleSegment[]],
);
/// B5-3.2 · certificaciones de operador de las verticales (conductor) derivadas del enum canónico
/// FleetDocumentType. Viajan en el ping para que dispatch gatee la eligibilidad de las verticales
/// (ambulancia exige AMBULANCE_OPERATOR) FAIL-CLOSED, sin consultar fleet en el hot-path.
const fleetDocumentTypeSchema = z.enum(
  Object.values(FleetDocumentType) as [FleetDocumentType, ...FleetDocumentType[]],
);

/// Modo de pricing/despacho (ADR 011). Espeja PricingMode de @veo/shared-types (PUJA | FIXED, cerrado
/// y estable — a diferencia de la clase de vehículo, que es un eje de extensión del catálogo). Se
/// declara como enum local y se reutiliza en los eventos de pricing.
const pricingMode = z.enum(['PUJA', 'FIXED']);

/* ── identity ── */
export const userRegistered = z.object({
  userId: z.string(),
  phone: z.string(),
  kycStatus: z.string(),
});
export const driverVerified = z.object({
  driverId: z.string(),
  userId: z.string(),
  verifiedAt: z.string(),
});
/// El operador RECHAZÓ los antecedentes del conductor (espejo de driver.verified). identity-service lo
/// emite por OUTBOX en la MISMA tx que persiste Driver.backgroundCheckStatus=REJECTED + rejectionReason.
/// Downstream: audit (traza inmutable de la decisión) y admin-bff (proyecta el motivo en el read-model
/// para que el panel lo muestre). `reason` = motivo del rechazo (texto del operador); "" si no se dio uno
/// (degradación honesta, nunca un motivo falso). El conductor lo VE en la app (RejectedScreen) vía GET
/// /drivers/me, no por este evento. `rejectedAt` ISO-8601 del momento del rechazo.
export const driverRejected = z.object({
  driverId: z.string(),
  userId: z.string(),
  reason: z.string(),
  rejectedAt: z.string(),
});
/// El operador SUSPENDIÓ manualmente al conductor desde el panel (acción admin, espejo de driver.rejected
/// pero del lado de la SUSPENSIÓN). identity-service lo emite por OUTBOX en la MISMA tx que el CAS de
/// `Driver.suspendedAt` (así nunca hay suspensión sin evento ni evento sin suspensión). Downstream:
/// audit-service (traza inmutable de la decisión) y admin-bff (proyecta status=SUSPENDED en el read-model
/// para que el panel lo refleje). Distinto de `fleet.driver_suspended` (suspensión AUTOMÁTICA por documento
/// crítico vencido, que emite fleet-service): este lo origina un operador. `reason` = motivo del operador
/// (texto libre, ""→honesto si no se dio). `suspendedAt` ISO-8601 del momento efectivo de la suspensión.
export const driverSuspended = z.object({
  driverId: z.string(),
  reason: z.string(),
  suspendedAt: z.string(),
  /// `userId` (User.id = claim `sub`) del conductor suspendido. OPTIONAL por evolución COMPATIBLE del
  /// contrato: los eventos en vuelo ANTES de este cambio no lo llevan; identity (único productor) SIEMPRE
  /// lo popula desde ahora (lo tiene en el momento de emitir). Lo consume EXCLUSIVAMENTE el BACKSTOP durable
  /// de revocación de identity (consumer de su propio `driver.suspended`), que resella `revoked:before:{userId}`
  /// al `suspendedAt` del evento por si el revoke post-commit best-effort no corrió (crash entre COMMIT y sello
  /// en Redis). Los demás consumers (driver-bff/dispatch/admin-bff/audit) keyean por `driverId`: para ellos un
  /// campo optional extra es no-op (no lo leen; audit proyecta por allowlist). Es PII-neutral (un id opaco).
  userId: z.string().optional(),
});
/// El conductor RECHAZADO corrigió sus datos y REENVIÓ a revisión (BR-I01). identity-service lo emite por
/// OUTBOX en la MISMA tx que lleva backgroundCheckStatus REJECTED→PENDING + KYC REJECTED→PENDING y limpia el
/// motivo. Downstream: admin-bff proyecta status=PENDING en el read-model → el conductor reaparece como
/// PENDIENTE (no stale en REJECTED) cerrando el double-source. `resubmittedAt` ISO-8601 del reenvío.
export const driverResubmitted = z.object({
  driverId: z.string(),
  userId: z.string(),
  resubmittedAt: z.string(),
});
/// El conductor MATERIALIZÓ su alta (primer dato del wizard que crea el agregado Driver, quedando PENDING de
/// revisión). identity-service lo emite por OUTBOX en la MISMA tx que CREA la fila Driver, EXACTAMENTE UNA VEZ:
/// el alta son dos upserts independientes del orden (datos personales / licencia) y solo el que GANA la creación
/// (INSERT ... ON CONFLICT DO NOTHING → count=1) emite; el otro ve la fila ya creada y no re-emite. Downstream:
/// admin-bff lo proyecta como status=PENDING en el read-model de conductores → el conductor aparece en la vista
/// de FLOTA ("Todos") desde el alta, no recién cuando hay una decisión (verified/rejected). Cierra el hueco de que
/// el read-model solo se sembraba con eventos de cambio de estado (la cola "Pendientes" ya lo veía vía identity
/// directo, pero la flota no). SIN PII en el payload (igual que el resto de driver.*): el nombre lo resuelve el
/// admin-bff por gRPC al listar. `registeredAt` ISO-8601 del momento de materialización.
export const driverRegistered = z.object({
  driverId: z.string(),
  userId: z.string(),
  registeredAt: z.string(),
});
/// El OPERADOR levantó una suspensión del conductor desde el panel (la inversa de driver.suspended).
/// identity-service lo emite por OUTBOX en la MISMA tx que QUITA el/los hold(s) y RECOMPUTA `Driver.suspendedAt`
/// derivado (modelo de HOLDS; así nunca hay reactivación sin evento ni evento sin reactivación). Lo emiten DOS
/// vías del operador, según qué hold levantan:
///   - `reactivate()` → levanta SOLO el hold DISCIPLINARY (la suspensión que el operador originó).
///   - `reactivateForCompliance()` → override manual: levanta los holds DOCUMENT_EXPIRED + INSPECTION_EXPIRED.
/// En ambas, si tras quitar su(s) hold(s) QUEDAN otros, el conductor SIGUE suspendido (`suspendedAt` recomputado
/// sigue seteado): el evento marca que se revirtió ESA causa, no que el conductor quedó libre. (La AUTO-reactivación
/// disparada por fleet —`reactivateByFleet`/`reactivateByFleetForUser`, cuando el conductor regulariza por su
/// cuenta— NO emite este evento: solo quita el hold; el badge de la lista se reconcilia on-read contra el
/// `suspendedAt` autoritativo de identity.) Downstream: audit-service (traza inmutable) y admin-bff (proyecta
/// status de SUSPENDED de vuelta a ACTIVE en el read-model). La reactivación SOLO levanta la suspensión: NO
/// devuelve al conductor a AVAILABLE — el gate biométrico de inicio de turno (BR-I02) sigue siendo el que lo
/// habilita a operar. `reactivatedAt` ISO-8601 del momento efectivo de la reactivación.
export const driverReactivated = z.object({
  driverId: z.string(),
  reactivatedAt: z.string(),
});
/// Señal REACTIVA de que un conductor pasó a OFFLINE (Fase B · ADR-021 · finding B1). La emiten DOS
/// productores por el MISMO contrato, distinguidos por `reason`:
///  - `shift_end`  — identity-service: el conductor cerró turno / se puso offline por autoservicio
///    (`setStatus`→OFFLINE), emitido por OUTBOX en la MISMA tx que el CAS de `Driver.currentStatus`.
///  - `disconnect` — driver-bff: el socket del conductor CAYÓ y NO reconectó dentro de la ventana de gracia
///    (chequeo de presencia CROSS-NODO vía el redis-adapter). Best-effort (el watchdog pre-recojo de trip es
///    el backstop si el evento se pierde: es un BFF sin outbox, igual que el firehose `driver.location_updated`).
/// Downstream (Fase B-react): dispatch RETIRA las ofertas OPEN del conductor de los boards
/// (`dispatch.offer_withdrawn` reason=stale) y lo EVICTA del pool (hot-index remove); trip-service, si el
/// conductor tenía un viaje PRE-RECOJO ya aceptado (ACCEPTED/ARRIVING/ARRIVED), lo REASIGNA reusando la
/// máquina existente (`reassignAfterDriverCancel` → `trip.reassigning` → re-abre el board) en vez de dejar al
/// pasajero esperando los ~15min del watchdog. `driverId` = id de PERFIL Driver (= `Trip.driverId`, el mismo
/// espacio de la cadena de suspensión). SIN PII: solo ids + la marca temporal. `at` ISO-8601.
export const DRIVER_OFFLINE_REASON = {
  /// Fin de turno / autoservicio (OFFLINE deliberado). Lo emite identity-service.
  SHIFT_END: 'shift_end',
  /// Caída del socket sin reconexión dentro de la ventana de gracia. Lo emite driver-bff.
  DISCONNECT: 'disconnect',
} as const;
export type DriverOfflineReason =
  (typeof DRIVER_OFFLINE_REASON)[keyof typeof DRIVER_OFFLINE_REASON];
export const driverWentOffline = z.object({
  driverId: z.string(),
  at: z.string(),
  reason: z.enum([DRIVER_OFFLINE_REASON.SHIFT_END, DRIVER_OFFLINE_REASON.DISCONNECT]),
});
/// Señal de que un conductor ABRIÓ turno (espejo de `went_offline` rama shift_end). La emite identity-service
/// en `startShift` — la ÚNICA transición OFFLINE→AVAILABLE, que SIEMPRE pasa por el gate biométrico — por OUTBOX
/// en la MISMA tx que el CAS de `Driver.currentStatus`→AVAILABLE. A diferencia de `went_offline` NO lleva
/// `reason`: hay una sola causa (apertura deliberada de turno; no existe un "online" best-effort). Es una
/// MUTACIÓN de negocio deliberada → se audita al WORM (par de apertura del ciclo de sesión del conductor).
/// `driverId` = id de PERFIL Driver (mismo espacio que `went_offline`). SIN PII: solo id + marca temporal.
export const driverWentOnline = z.object({
  driverId: z.string(),
  at: z.string(),
});
export const userKycVerified = z.object({
  userId: z.string(),
  kycStatus: z.string(),
  verifiedAt: z.string(),
});
/// El usuario confirmó la titularidad de su correo (ADR-012, método correo+contraseña). identity-service
/// lo emite en la MISMA tx que marca el AuthMethod.emailVerified=true. Downstream: onboarding/CRM.
export const userEmailVerified = z.object({
  userId: z.string(),
  email: z.string(),
  verifiedAt: z.string(),
});
export const biometricFailed = z.object({
  driverId: z.string(),
  score: z.number(),
  attempt: z.number(),
  at: z.string(),
});
/// El conductor ENROLÓ su biometría facial en el alta (KYC: selfie + liveness PASIVO). identity-service lo
/// emite por OUTBOX en la MISMA tx que persiste faceEmbedding + faceEnrolledAt → audit (traza inmutable
/// Ley 29733 de que SE ejecutó una verificación biométrica de alta y su veredicto de vida). `livenessChecked`
/// = si el PAD corrió (false = modelo ausente → enrolado SIN liveness, degradación honesta); `score` = score
/// de vida del PAD 0..1. SIN datos biométricos en el payload: solo el veredicto + metadatos. `at` ISO-8601.
export const biometricEnrolled = z.object({
  driverId: z.string(),
  userId: z.string(),
  livenessChecked: z.boolean(),
  score: z.number(),
  at: z.string(),
});
/// El enrol biométrico del alta fue RECHAZADO por el anti-spoofing PASIVO (PAD): la captura es un ataque de
/// presentación (foto/pantalla/replay). identity-service lo emite por OUTBOX en una tx PROPIA y forense
/// (persiste aunque el request termine en 422) → audit (traza inmutable del intento de suplantación, Ley
/// 29733). `reason` = motivo tipado del rechazo ('spoof'); `score` = score de vida 0..1. SIN biometría. `at`.
export const biometricEnrollRejected = z.object({
  driverId: z.string(),
  userId: z.string(),
  reason: z.string(),
  score: z.number(),
  at: z.string(),
});
export const userDeletionRequested = z.object({
  userId: z.string(),
  requestedAt: z.string(),
  graceUntil: z.string(),
});
/// Borrado EFECTIVO de la cuenta (BR-S06 derecho al olvido): el sweeper aplicó el tombstone vencida
/// la gracia. Señal de cascada para que los consumidores downstream purguen su PII del usuario.
/// `driverId` presente si el usuario tenía perfil de conductor. Distinto de user.deletion_requested
/// (que se emite al SOLICITAR el borrado, no al ejecutarlo).
export const userDeleted = z.object({
  userId: z.string(),
  driverId: z.string().optional(),
  at: z.string(),
});
export const adminRoleChanged = z.object({
  adminUserId: z.string(),
  roles: z.array(z.string()),
  changedBy: z.string(),
  at: z.string(),
});

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
  /// B5-3 · oferta del viaje (offeringId del catálogo, ej. veo_confort). dispatch resuelve sus REQUISITOS
  /// (segment/seats/antigüedad) para filtrar el pool por eligibilidad. Opcional/compat: ausente o
  /// desconocido ⇒ sin requisitos extra (el pool solo filtra por vehicleType, como antes).
  category: z.string().optional(),
  /// Ola 2B · viaje programado: marca que el viaje se activó desde el scheduler (reserva). dispatch
  /// puede incluirlo en la oferta como "reservado". Opcional.
  scheduled: z.boolean().optional(),
  /// Ola 2B · paradas intermedias ORDENADAS (máx 3). dispatch las recibe en el riel de eventos (no por
  /// join cross-servicio) para poder contemplarlas en el matching/oferta. Omitible por compat N-2 (= []).
  waypoints: z.array(geo).max(3).optional(),
});
export const tripAssigned = z.object({
  tripId: z.string(),
  driverId: z.string(),
  vehicleId: z.string(),
});
/// `passengerId` ENRIQUECIDO (opcional, compat N-2): trip-service lo añade al outbox para que
/// notification-service resuelva el token del pasajero (push "tu conductor confirmó") sin un join
/// cross-servicio. Ausente en eventos viejos → el consumidor degrada honesto (omite el push).
export const tripAccepted = z.object({
  tripId: z.string(),
  driverId: z.string(),
  etaSeconds: z.number().int(),
  passengerId: z.string().optional(),
});
export const tripArriving = z.object({
  tripId: z.string(),
  driverId: z.string(),
  etaSeconds: z.number().int(),
  at: z.string(),
  passengerId: z.string().optional(),
});
/// `waitWindowSeconds` ENRIQUECIDO (opcional): ventana de espera del conductor en el punto de recojo
/// antes de poder cobrar penalidad/cancelar. notification-service la incluye en el push "tu conductor
/// llegó" si viaja. `passengerId` ídem accepted/arriving.
export const tripArrived = z.object({
  tripId: z.string(),
  driverId: z.string(),
  at: z.string(),
  passengerId: z.string().optional(),
  waitWindowSeconds: z.number().int().optional(),
});
export const tripStarted = z.object({
  tripId: z.string(),
  driverId: z.string(),
  startedAt: z.string(),
  passengerId: z.string().optional(),
});
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
export const dispatchMatchFound = z.object({
  tripId: z.string(),
  driverId: z.string(),
  vehicleId: z.string().optional(),
  scoreMs: z.number(),
});
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
  /// ETA conductor→recojo en segundos (efímero, momento-de-oferta, solo camino FIXED). Opcional porque el
  /// broadcast de PUJA no lo lleva y una oferta con maps.eta caído lo omite. La app lo muestra como el stat
  /// "A recojo".
  pickupEtaSeconds: z.number().int().nonnegative().optional(),
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
  /// B5-3 · oferta del viaje (offeringId del catálogo, ej. veo_xl). dispatch la persiste en el board y
  /// deriva sus REQUISITOS (segment/seats/antigüedad/certs) para enforcar la eligibilidad por TIER en la
  /// PUJA igual que en FIXED. Opcional/compat N-2: ausente o desconocido ⇒ sin requisitos extra (el gate
  /// solo filtra por vehicleType, como antes).
  category: z.string().optional(),
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
/// Motivos por los que UNA oferta del board se RETIRA (evento `dispatch.offer_withdrawn`). Fuente ÚNICA
/// del valor (const + tipo derivado homónimo; cero literales sueltos): el productor (dispatch) importa esta
/// const para no hardcodear el string en el emit, y el `z.enum` de abajo se deriva de acá.
export const OFFER_WITHDRAWN_REASON = {
  /// El conductor quedó INELEGIBLE tras ofertar, con el board aún ABIERTO (BE-3).
  STALE: 'stale',
  /// Otro conductor ganó la EMERGENCIA en el broadcast simultáneo de la ambulancia (B5-vert): la oferta
  /// hermana ya no vale.
  TAKEN: 'taken',
  /// ADR-020 Lote 2 — el pasajero ELIGIÓ a OTRO conductor: la oferta de este perdedor ya no vale y su
  /// card debe morir reactiva (sin esperar el poll de 12s). Se emite UNA por perdedor al cerrar el board.
  NOT_SELECTED: 'not_selected',
} as const;
export type OfferWithdrawnReason =
  (typeof OFFER_WITHDRAWN_REASON)[keyof typeof OFFER_WITHDRAWN_REASON];

export const dispatchOfferWithdrawn = z.object({
  tripId: z.string(),
  driverId: z.string(),
  /// `stale` = el conductor quedó inelegible tras ofertar (board PUJA). `taken` = otro conductor ganó la
  /// EMERGENCIA del broadcast simultáneo de la ambulancia (B5-vert). `not_selected` (ADR-020 Lote 2) = el
  /// pasajero eligió a otro y esta oferta perdió — el driver-bff la reenvía al CONDUCTOR (card muere reactiva).
  reason: z.enum([
    OFFER_WITHDRAWN_REASON.STALE,
    OFFER_WITHDRAWN_REASON.TAKEN,
    OFFER_WITHDRAWN_REASON.NOT_SELECTED,
  ]),
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
  /// B5-3 · oferta del viaje (offeringId): dispatch la re-persiste en el board re-abierto para enforcar la
  /// eligibilidad por TIER en el re-match igual que en la puja original. Opcional/compat N-2: ausente o
  /// desconocido ⇒ sin requisitos extra.
  category: z.string().optional(),
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

/// Piso de la PUJA (bid floor) reemplazado por el admin (ADR 010 §9.3). Emitido por outbox en la MISMA tx
/// del PUT; lo consume PricingCacheConsumer para invalidar el cache del piso cross-réplica (NO load-bearing:
/// trip-service lee la tabla local). `overrides` = piso por oferta; sin override la oferta cae
/// al `defaultFloorCents`. `version` MONOTÓNICA (la invalidación de cache es idempotente y tolera reorden).
export const pricingBidFloorUpdated = z.object({
  /// Piso por defecto en céntimos PEN (cuando no hay override para la oferta).
  defaultFloorCents: z.number().int().nonnegative(),
  /// Overrides del piso por oferta. `offeringId` es el enum de @veo/shared-types (string en wire).
  overrides: z.array(
    z.object({
      offeringId: z.string(),
      floorCents: z.number().int().nonnegative(),
    }),
  ),
  /// Versión MONOTÓNICA (la invalidación de cache es idempotente; tolera el reordenamiento at-least-once).
  version: z.number().int().nonnegative(),
  /// Marca ISO de cuándo el admin guardó el snapshot.
  updatedAt: z.string(),
});

/// Tarifa base (banderazo + per-km + per-min) reemplazada por el admin (F2.4). Emitida por outbox en la
/// MISMA tx del PUT; la consume PricingCacheConsumer para invalidar el cache de la tarifa base cross-réplica
/// (NO load-bearing: trip-service lee la tabla local). Los tres componentes en céntimos PEN. `version`
/// MONOTÓNICA (la invalidación de cache es idempotente y tolera el reordenamiento at-least-once de Kafka).
export const pricingBaseFareUpdated = z.object({
  /// Banderazo (tarifa fija de arranque) en céntimos PEN.
  baseFareCents: z.number().int().nonnegative(),
  /// Costo por kilómetro en céntimos PEN.
  perKmCents: z.number().int().nonnegative(),
  /// Costo por minuto en céntimos PEN.
  perMinCents: z.number().int().nonnegative(),
  /// Versión MONOTÓNICA (la invalidación de cache es idempotente; tolera el reordenamiento at-least-once).
  version: z.number().int().nonnegative(),
  /// Marca ISO de cuándo el admin guardó el snapshot.
  updatedAt: z.string(),
});

/// Comisión de plataforma por MODO reemplazada por el admin (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). Emitida
/// por outbox en la MISMA tx del PUT; la consume CommissionCacheConsumer (payment-service) para invalidar el
/// cache de la tasa cross-réplica (NO load-bearing: payment-service lee la tabla local). SOLO la tasa ON-DEMAND
/// es configurable; la del CARPOOLING es 0 FIJO (gated por validación legal, NO viaja en este evento). La tasa
/// va en BASIS POINTS Int (0..10000) — NUNCA float (dinero/tasa). `version` MONOTÓNICA (invalidación idempotente).
export const paymentCommissionUpdated = z.object({
  /// Tasa de comisión ON-DEMAND en basis points (0..10000; 2000 = 20%). Int, jamás float.
  onDemandRateBps: z.number().int().min(0).max(10_000),
  /// Service fee CARPOOLING en basis points (0..10000). Int, jamás float. Se SUMA al pasajero (cost-sharing).
  carpoolingFeeBps: z.number().int().min(0).max(10_000),
  /// Versión MONOTÓNICA (la invalidación de cache es idempotente; tolera el reordenamiento at-least-once).
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
  /// IDENTIDAD del vehículo activo (del que se resolvieron los attrs de abajo). dispatch lo usa como KEY del
  /// carry anti-clobber del hot-index: preservar attrs ausentes solo si el ping previo es el MISMO vehículo
  /// (vehicleType NO distingue dos autos de la misma clase — un XL y un económico son ambos CAR). El bff lo
  /// sella server-authoritative igual que los attrs. Opcional por compat (pings legacy / fleet 204 sin vehículo
  /// activo) ⇒ SIN vehicleId NO hay carry (el fallback por vehicleType fue ELIMINADO en el lote d.1: el carry
  /// es estricto por vehicleId). Degradación honesta: cero stale (no se preservan attrs de otro vehículo) a
  /// cambio de no rellenar el hueco. Prerequisito del flip a fail-closed.
  vehicleId: z.string().optional(),
  /// B5-3 · atributos de eligibilidad del vehículo activo (del modelSpec elegido + el año del vehículo).
  /// dispatch los proyecta en el hot-index para filtrar por oferta (confort=segment≥MID, xl=6 asientos)
  /// SIN consultar fleet en el hot-path. Opcionales por compat: un ping sin ellos NO restringe (el pool
  /// degrada a "elegible" hasta que el productor los mande — no rompe el matching existente).
  seats: z.number().int().positive().optional(),
  segment: vehicleSegmentSchema.optional(),
  vehicleYear: z.number().int().optional(),
  /// B5-3.2 · certificaciones de operador VIGENTES del conductor (las verticales exigen la suya). dispatch
  /// las proyecta en el hot-index y gatea la eligibilidad FAIL-CLOSED: una vertical sin la cert NO se ofrece.
  /// Opcional por compat (pings sin ella) — para una oferta SIN certs requeridas no cambia nada; para una
  /// vertical, su ausencia = inelegible (fail-closed, a diferencia de los attrs del vehículo que son fail-open).
  certifications: z.array(fleetDocumentTypeSchema).optional(),
});
export const driverEnteredZone = z.object({
  driverId: z.string(),
  zoneId: z.string(),
  at: z.string(),
});

/* ── media ── (BR-S01 cámara) */
export const mediaRecordingStarted = z.object({
  tripId: z.string(),
  roomName: z.string(),
  startedAt: z.string(),
});
export const mediaArchived = z.object({
  tripId: z.string(),
  s3Key: z.string(),
  bytes: z.number().int(),
  retentionDays: z.number().int(),
});
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
/// BR-S02: el supervisor RECHAZA la solicitud (cierra sin otorgar acceso). Auditado en cadena de custodia.
export const mediaAccessRejected = z.object({
  requestId: z.string(),
  tripId: z.string(),
  segmentId: z.string().optional(),
  operatorId: z.string(),
  rejectedBy: z.string(),
  at: z.string(),
});
/// BR-S02: cada VISUALIZACIÓN de un video aprobado se audita (se firma URL + watermark fresco por acceso).
export const mediaAccessViewed = z.object({
  requestId: z.string(),
  tripId: z.string(),
  segmentId: z.string(),
  operatorId: z.string(),
  operatorEmail: z.string(),
  viewedBy: z.string(),
  watermark: z.string(),
  expiresAt: z.string(),
  at: z.string(),
});
/// BR-S02 (Lote 3 · burn-in): el quemado server-side del watermark de la copia derivada TERMINÓ OK. SIN PII:
/// el operador (quién pidió) ya está en `media.access_granted`; acá solo IDs técnicos de la copia lista.
export const mediaRenderCompleted = z.object({
  requestId: z.string(),
  tripId: z.string(),
  segmentId: z.string(),
  at: z.string(),
});
/// BR-S02 (Lote 3 · burn-in): el quemado del watermark FALLÓ. SIN PII: `reason` es una CATEGORÍA técnica
/// (clase de error), nunca texto libre ni datos del operador/video.
export const mediaRenderFailed = z.object({
  requestId: z.string(),
  tripId: z.string(),
  reason: z.string(),
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
export const paymentFailed = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  reason: z.string(),
  willRetry: z.boolean(),
});
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

/**
 * payout.processed (ADR-015 §4.1 · semántica corregida en 2b): el riel CONFIRMÓ la salida del dinero
 * (PROCESSING → PROCESSED) — la plata SALIÓ de verdad. audit + notification (push al conductor, D7) lo consumen.
 * Mismo contrato SIN PII + `.strict()` fail-closed que payout.processing/failed: solo IDs + monto + período;
 * la billetera destino jamás viaja por Kafka. `.strict()` RECHAZA campos extra → falla-CERRADO contra fugas de PII.
 */
export const payoutProcessed = z
  .object({
    payoutId: z.string(),
    driverId: z.string(),
    amountCents: z.number().int(),
    period: z.string(),
  })
  .strict();

/**
 * payout.processing (ADR-015 §4.1 · NUEVO): el OPERADOR disparó el desembolso (PENDING/HELD → PROCESSING)
 * e invocó `PayoutGateway.disburse`. Traza el acto humano. audit lo consume.
 *
 * SOBERANÍA (FOUNDATION §0.7 · ADR-015 D2/D7): CERO PII en el payload — solo IDs + monto + período. La
 * billetera destino NUNCA viaja por Kafka (la resuelve el adapter server-side). `.strict()` RECHAZA cualquier
 * campo extra (un teléfono/nombre filtrado) → el contrato falla-CERRADO contra fugas de PII, verificado por test.
 */
export const payoutProcessing = z
  .object({
    payoutId: z.string(),
    driverId: z.string(),
    amountCents: z.number().int(),
    period: z.string(),
  })
  .strict();

/**
 * payout.failed (ADR-015 §4.1 · NUEVO): el riel rechazó/expiró el desembolso (PROCESSING → FAILED). La plata
 * NO salió; el operador puede reintentar (idempotente por `dedupKey`). audit + notification (avisa al operador)
 * lo consumen. Mismo contrato SIN PII + `.strict()` fail-closed que payout.processing.
 */
export const payoutFailed = z
  .object({
    payoutId: z.string(),
    driverId: z.string(),
    amountCents: z.number().int(),
    period: z.string(),
  })
  .strict();

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
export const notificationSent = z.object({
  notificationId: z.string(),
  channel: z.enum(['PUSH', 'SMS', 'EMAIL', 'WEBHOOK']),
  to: z.string(),
});
/** Reservado para entrega REAL confirmada por receipt (FCM BigQuery export / futuro). Hoy NO se emite. */
export const notificationDelivered = z.object({
  notificationId: z.string(),
  channel: z.enum(['PUSH', 'SMS', 'EMAIL', 'WEBHOOK']),
  to: z.string(),
});
export const notificationFailed = z.object({
  notificationId: z.string(),
  channel: z.string(),
  error: z.string(),
});

/* ── rating ── (BR-D01 / BR-I05) */
/**
 * Razones de flag de rating — CONTRATO CANÓNICO del wire (cero strings mágicos en el `===` de los consumidores).
 * rating-service es DUEÑO del dominio pero el VALOR viaja por `driver.flagged`/`passenger.flagged`, así que el
 * enum vive AQUÍ (paquete leaf `@veo/events`, sin ciclo de dependencias) y rating-service IMPORTA estos valores
 * para su `FLAG_REASON` de dominio — una sola lista, no dos que se desincronizan. identity discrimina por estos
 * mismos valores tipados:
 *   - 'review'         conductor < 4.3 (o < 4.0 sin el mínimo de reseñas): flag de PANEL, NO suspende.
 *   - 'suspension'     conductor < 4.0 con ≥ mínimo de reseñas: dispara la AUTO-suspensión (hold RATING_LOW).
 *   - 'reverification' pasajero < 4.0 (BR-I05): requiere re-verificación.
 */
export const FLAG_REASON = {
  REVIEW: 'review',
  SUSPENSION: 'suspension',
  REVERIFICATION: 'reverification',
} as const;
export type FlagReason = (typeof FLAG_REASON)[keyof typeof FLAG_REASON];
/** z.enum tipado del contrato: el `parse` del evento RECHAZA un reason fuera de FLAG_REASON (falla-cerrado). */
const flagReasonSchema = z.enum(Object.values(FLAG_REASON) as [FlagReason, ...FlagReason[]]);
export const ratingCreated = z.object({
  ratingId: z.string(),
  tripId: z.string(),
  driverId: z.string(),
  stars: z.number().int().min(1).max(5),
});
export const driverFlagged = z.object({
  driverId: z.string(),
  rollingAvg: z.number(),
  reason: flagReasonSchema,
});
export const passengerFlagged = z.object({
  passengerId: z.string(),
  rollingAvg: z.number(),
  reason: flagReasonSchema,
});
/**
 * AUTO-suspensión por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad). dispatch-service
 * mantiene una VENTANA ROLLING de 24h de cancelaciones POR conductor (tabla `driver_cancellation_events`,
 * SEPARADA del contador LIFELONG `driver_stats.cancelled_trips` que alimenta la tasa de cancelación del
 * matching) y emite ESTE evento UNA vez cuando el conteo de la ventana CRUZA el umbral (4→5). identity lo
 * materializa como un hold TEMPORAL EXCESSIVE_CANCELLATIONS con `expiresAt = now + cooldown` (primer hold con
 * expiración del sistema; un sweeper lo auto-levanta al vencer). Es una causa AUTOMÁTICA (NO-disciplinaria):
 * la levanta el override de compliance del operador (reactivateForCompliance) ANTES del vencimiento, o el
 * sweeper al vencer el cooldown.
 *
 * `driverId` = id de PERFIL Driver (= `Trip.driverId`, el MISMO que resuelve dispatch vía `driverForTrip` →
 * `dispatch_matches.driver_id`, que ya es el id de perfil). NUNCA un User.id: la cadena de suspensión exige
 * el de perfil (como `driver.flagged`). `count` = cancelaciones en la ventana al cruzar (≥ umbral, típico = 5).
 * `windowStart` ISO-8601 = borde inferior de la ventana de 24h al momento del cruce (trazabilidad). `occurredAt`
 * ISO-8601 = momento del cruce. El hold downstream es IDEMPOTENTE (re-entregas no extienden el cooldown).
 */
export const driverExcessiveCancellations = z.object({
  driverId: z.string(),
  count: z.number().int(),
  windowStart: z.string(),
  occurredAt: z.string(),
});

/* ── share ── (pilar 4) */
export const shareLinkGenerated = z.object({
  shareId: z.string(),
  tripId: z.string(),
  expiresAt: z.string(),
});
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
/// audit-service grabó un eslabón TAMPER-EVIDENT en el audit log hash-encadenado (Ley 29733). Emitido por
/// OUTBOX en la MISMA tx que escribe la fila → un consumidor (dashboard de seguridad / verificador de cadena)
/// puede reaccionar con la prueba criptográfica. `entryId` = id de la fila; `seq` = posición en la cadena;
/// `hash` = hash del eslabón; `eventId` = evento de dominio que originó la auditoría (correlación); `at` ISO-8601.
export const auditRecorded = z.object({
  entryId: z.string(),
  seq: z.string(),
  eventId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  actorId: z.string().optional(),
  at: z.string(),
  hash: z.string(),
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
/// El operador RECHAZÓ un documento del conductor en la revisión manual (`reviewDocument`, decision=REJECTED).
/// fleet-service lo emite por OUTBOX en la MISMA tx que persiste `FleetDocument.status=REJECTED` + rejectionReason.
/// Downstream: notification-service (push al conductor: "corregí tu documento") + audit (traza inmutable de la
/// decisión de compliance, Ley 29733). Cierra la ASIMETRÍA de aviso — antes SOLO el rechazo del ALTA
/// (driver.rejected) notificaba; el rechazo POR-DOCUMENTO era silencioso. `ownerId` = Driver.id de PERFIL (doc
/// DRIVER-scoped); el push lo resuelve a userId por gRPC. El `reason` (texto libre del operador) NO viaja en el
/// evento (data-minimization §0.7: ningún consumer lo necesita — la app lo muestra vía GET /drivers/me/documents,
/// que lo lee de la fila `FleetDocument`; el audit inmutable excluye free-text por política). `rejectedAt` ISO-8601.
export const fleetDocumentRejected = z.object({
  documentId: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  documentType: z.string(),
  rejectedAt: z.string(),
});
export const fleetDriverSuspended = z
  .object({
    // SUJETO de la suspensión: el conductor llega por UNA de dos claves, según el ORIGEN:
    //  - `driverId` (id de PERFIL Driver de identity) → suspensión por DOCUMENTO crítico vencido. fleet lo
    //    conoce porque `FleetDocument.ownerId` de un doc DRIVER-scoped ES el id de perfil.
    //  - `userId` (User.id de identity = `Vehicle.driverId`) → suspensión por INSPECCIÓN técnica (ITV) vencida.
    //    fleet SOLO tiene el User.id del dueño del vehículo (no traduce a id de perfil): identity resuelve
    //    User.id → Driver.id en SU consumer (es el dueño del mapeo). Mantiene fleet desacoplado de identity.
    // El consumer EXIGE exactamente una vía (ver refine); nunca confunde un User.id con un Driver.id de perfil.
    driverId: z.string().optional(),
    userId: z.string().optional(),
    reason: z.string(),
    documentId: z.string().optional(),
    documentType: z.string().optional(),
    // Trazabilidad de la suspensión por ITV (opcionales; ausentes en la suspensión por documento).
    vehicleId: z.string().optional(),
    inspectionId: z.string().optional(),
    nextDueAt: z.string().optional(),
    suspendedAt: z.string(),
  })
  .refine((p) => Boolean(p.driverId) !== Boolean(p.userId), {
    message: 'fleetDriverSuspended exige EXACTAMENTE uno de driverId (perfil) o userId (User.id)',
  });
/// AUTO-reactivación de un conductor por compliance: el conductor REGULARIZÓ lo que lo tenía suspendido por
/// `DOCUMENT_EXPIRED`/`INSPECTION_EXPIRED` (la INVERSA AUTOMÁTICA de `fleet.driver_suspended`). fleet-service lo
/// emite por OUTBOX en la MISMA tx que registra la regularización (escritura + evento atómicos, FOUNDATION §6).
/// Espeja el XOR de claves de la suspensión, según el ORIGEN de la regularización:
///   - `userId` (User.id = `Vehicle.driverId`) → se registró una INSPECCIÓN técnica (ITV) NUEVA y VIGENTE para
///     el vehículo operado: fleet emite por userId (fleet NO traduce a id de perfil; identity resuelve
///     User.id → Driver.id en SU consumer, igual que en la suspensión). Ya NO hay un latch local de ITV en fleet
///     (eliminado con el refactor a holds): la idempotencia vive en el `@@unique` del hold en identity.
///   - `driverId` (id de PERFIL Driver) → un DOCUMENTO crítico DRIVER-scoped vencido volvió a VALID (revisión del
///     operador): fleet lo conoce porque `FleetDocument.ownerId` de un doc DRIVER-scoped ES el id de perfil.
/// El consumer de identity EXIGE exactamente una vía (refine, espejo de la suspensión) y QUITA SOLO el hold de
/// ESA causa (DOCUMENT_EXPIRED de ese documentType por la vía driverId, o INSPECTION_EXPIRED por la vía userId);
/// las demás causas (otro documento, ITV, DISCIPLINARY) quedan intactas — fail-closed por modelo de HOLDS.
/// Downstream: identity recomputa `Driver.suspendedAt` derivado del conjunto de holds (idempotente; el difunto
/// `suspensionSource` fue DROPeado con el refactor a holds). Esta AUTO-reactivación de fleet NO emite el evento de
/// dominio `driver.reactivated` (ese solo lo emite la reactivación del OPERADOR) → el badge de la lista del panel
/// se reconcilia on-read contra el `suspendedAt` autoritativo de identity, no por proyección de evento.
/// La reactivación SOLO levanta el hold: NO devuelve al conductor a AVAILABLE (eso lo decide el gate biométrico
/// de inicio de turno, BR-I02). `reactivatedAt` ISO-8601 del momento efectivo de la regularización.
export const fleetDriverReactivated = z
  .object({
    driverId: z.string().optional(),
    userId: z.string().optional(),
    reason: z.string(),
    // Trazabilidad de la reactivación por ITV (opcionales; ausentes en la reactivación por documento).
    vehicleId: z.string().optional(),
    inspectionId: z.string().optional(),
    nextDueAt: z.string().optional(),
    // Trazabilidad de la reactivación por documento (opcionales; ausentes en la reactivación por ITV).
    documentId: z.string().optional(),
    documentType: z.string().optional(),
    reactivatedAt: z.string(),
  })
  .refine((p) => Boolean(p.driverId) !== Boolean(p.userId), {
    message: 'fleetDriverReactivated exige EXACTAMENTE uno de driverId (perfil) o userId (User.id)',
  });
export const fleetVehicleSuspended = z.object({
  vehicleId: z.string(),
  reason: z.string(),
  suspendedAt: z.string(),
});
export const fleetVehicleRegistered = z.object({
  vehicleId: z.string(),
  driverId: z.string(),
  plate: z.string(),
  vehicleType: vehicleClassSchema,
  registeredAt: z.string(),
});
export const fleetVehicleModelReviewed = z.object({
  modelId: z.string(),
  requestedBy: z.string(), // userId del conductor que solicitó el modelo (destinatario del push)
  verdict: z.enum(['APPROVED', 'REJECTED']),
  make: z.string(),
  model: z.string(),
  reviewedAt: z.string(),
});

/* ── booking (marketplace de carpooling PROGRAMADO · ADR-014) ── */
/// Se PUBLICÓ un PublishedTrip (la oferta del conductor pasó a BORRADOR → PUBLICADO). booking-service lo
/// emite por OUTBOX en la MISMA tx que crea la oferta (FOUNDATION §6 / ADR-014 §7). Topic 'booking'
/// (el prefijo `booking.` mantiene el topic; `topicForEvent` corta antes del punto), key = publishedTripId.
/// Downstream núcleo: notification. Dinero en céntimos PEN (Int).
///
/// NOMBRE (ADR-014 §7.1, alineado): este evento es la PUBLICACIÓN del PublishedTrip, NO la creación de un
/// Booking. Antes se llamaba `booking.created` (nombre invertido: §7.1 reserva `booking.created` para "se
/// crea un Booking"). Se renombra a `booking.published` para que el nombre refleje el agregado real (la
/// OFERTA), sin cambiar el topic 'booking'.
export const bookingPublished = z.object({
  publishedTripId: z.string(),
  driverId: z.string(),
  vehicleId: z.string(),
  asientosTotales: z.number().int(),
  precioBase: z.number().int(), // céntimos PEN
  modoReserva: z.enum(['INSTANT_BOOKING', 'REVISION_CADA_SOLICITUD']),
  fechaHoraSalida: z.string(),
  pais: z.string(),
  moneda: z.string(),
});
/// Se CREÓ un Booking en modo REVISION → PENDIENTE_APROBACION (espera al conductor). ADR-014 §7.1:
/// `booking.requested` = "Booking → PENDIENTE_APROBACION". SOLO se emite en REVISION_CADA_SOLICITUD; en
/// INSTANT el Booking NACE APROBADO y emite `booking.approved` (no `booking.requested`). booking-service lo
/// emite por OUTBOX en la MISMA tx que crea la reserva. Topic 'booking', key = bookingId.
export const bookingRequested = z.object({
  bookingId: z.string(),
  publishedTripId: z.string(),
  passengerId: z.string(),
  driverId: z.string(),
  asientos: z.number().int(),
  precioAcordado: z.number().int(), // céntimos PEN = base + specialRequest
  modoReserva: z.literal('REVISION_CADA_SOLICITUD'),
  estado: z.literal('PENDIENTE_APROBACION'),
});
/// Origen de un `booking.approved` (ADR-014 §7.1): por qué el Booking quedó APROBADO. FUENTE ÚNICA tipada,
/// exportada JUNTO al schema para que el PRODUCTOR (booking-service) y el SCHEMA publicado NO puedan divergir
/// (el bug clásico: el productor emite un literal mágico `'DRIVER_APPROVAL'` que NO está en el enum → el relay
/// hace schema.parse() → LANZA → poison message reintentado para siempre, nunca llega a Kafka). El productor
/// importa `BookingApprovedOrigen.X`, NUNCA un string suelto. Los valores son los EXACTOS del `z.enum` de abajo.
export const BookingApprovedOrigen = {
  /// INSTANT_BOOKING: el Booking nace APROBADO al reservar (salta PENDIENTE_APROBACION, §4.2).
  INSTANT_BOOKING: 'INSTANT_BOOKING',
  /// El conductor aprobó una solicitud en REVISION (PENDIENTE_APROBACION → APROBADO, F1/F3b).
  APROBACION_CONDUCTOR: 'APROBACION_CONDUCTOR',
} as const;
export type BookingApprovedOrigen =
  (typeof BookingApprovedOrigen)[keyof typeof BookingApprovedOrigen];

/// El Booking quedó APROBADO. ADR-014 §7.1: `booking.approved` = "APROBADO (dispara CHARGE async)". Dos
/// orígenes: (a) INSTANT_BOOKING, el Booking nace APROBADO al reservar (salta PENDIENTE_APROBACION, §4.2);
/// (b) REVISION, el conductor aprueba (F1). El campo `origen` distingue ambos para el consumidor. Topic
/// 'booking', key = bookingId. El enum del `origen` es la fuente única `BookingApprovedOrigen` (arriba): el
/// `z.enum` toma sus valores de ahí para que productor y schema NO diverjan (cero strings mágicos sueltos).
export const bookingApproved = z.object({
  bookingId: z.string(),
  publishedTripId: z.string(),
  passengerId: z.string(),
  driverId: z.string(),
  asientos: z.number().int(),
  precioAcordado: z.number().int(), // céntimos PEN
  modoReserva: z.enum(['INSTANT_BOOKING', 'REVISION_CADA_SOLICITUD']),
  estado: z.literal('APROBADO'),
  origen: z.enum([
    BookingApprovedOrigen.INSTANT_BOOKING,
    BookingApprovedOrigen.APROBACION_CONDUCTOR,
  ]),
});
/// El conductor EDITÓ su oferta publicada (F1a). Solo es editable mientras está PUBLICADO (sin reservas
/// confirmadas / pre-EN_RUTA): itinerario/precio/asientos/modoReserva/reglas. Se emite por OUTBOX en la
/// MISMA tx que la mutación (espeja booking.published). Topic 'booking', key = publishedTripId. Los campos
/// son OPCIONALES: el evento lleva solo lo que cambió (patch), más el publishedTripId/driverId de contexto.
export const bookingUpdated = z.object({
  publishedTripId: z.string(),
  driverId: z.string(),
  vehicleId: z.string().optional(),
  origenLat: z.number().optional(),
  origenLon: z.number().optional(),
  destinoLat: z.number().optional(),
  destinoLon: z.number().optional(),
  asientosTotales: z.number().int().optional(),
  precioBase: z.number().int().optional(), // céntimos PEN
  modoReserva: z.enum(['INSTANT_BOOKING', 'REVISION_CADA_SOLICITUD']).optional(),
  fechaHoraSalida: z.string().optional(),
  reglas: z.string().nullable().optional(),
});
/// Razón TIPADA de un `booking.cancelled` de un BOOKING individual (F3b/F3c). FUENTE ÚNICA (espeja
/// BookingApprovedOrigen): el productor emite `BookingCancelledRazon.X`, NUNCA un literal suelto. F3b dejó un
/// único valor (el cobro síncrono rechazó al disparar); F3c agrega los DOS caminos del consumer de
/// payment.captured/failed. El fan-out de Refund por cancelación-de-oferta (forma A) NO lleva razón.
///
/// CONSECUENCIA PARA EL REFUND (payment-service · F3c-payment · PENDIENTE): payment refundará los
/// `booking.cancelled` con razon=ASIENTO_LLENO u OFERTA_NO_DISPONIBLE (hubo CAPTURA: el dinero se movió y hay
/// que devolverlo). COBRO_RECHAZADO y COBRO_FALLIDO NO se refundan: charge-on-approval sin hold → no se capturó
/// nada que devolver.
export const BookingCancelledRazon = {
  /// (F3b · disparo síncrono) El CHARGE rechazó SÍNCRONAMENTE al dispararlo (decline DEBT/FAILED, o error
  /// PERMANENTE 4xx de payment · ADR-014 §5.4 "falla permanente → CANCELADO"). El asiento NO se decrementó
  /// (charge-on-approval sin hold). SIN Refund (no se capturó nada).
  COBRO_RECHAZADO: 'COBRO_RECHAZADO',
  /// (F3c · handler de payment.captured · ADR-014 §6 camino infeliz) El cobro SÍ capturó, pero al correr la txn
  /// atómica del seat-lock el asiento YA estaba lleno (otro booking confirmó el último asiento primero) →
  /// COBRO_PENDIENTE → CANCELADO. ÚNICO caso con Refund (payment-service devuelve la captura · F3c-payment).
  ASIENTO_LLENO: 'ASIENTO_LLENO',
  /// (F3c · handler de payment.failed · ADR-014 §5.4 / BR-P02) El riel agotó sus reintentos internos
  /// (willRetry=false → DEBT permanente) → COBRO_PENDIENTE → CANCELADO. SIN Refund (nunca se capturó). La deuda
  /// se DERIVA de PaymentStatus.DEBT de payment-service; booking NO crea un flag DEBT propio.
  COBRO_FALLIDO: 'COBRO_FALLIDO',
  /// (F3c · GUARD DEFENSIVO del seat-lock · ADR-014 §6) El cobro SÍ capturó, pero al correr la txn atómica la
  /// OFERTA ya NO está en un estado RESERVABLE (anómalo / futuro EN_RUTA-COMPLETADO-CANCELADO de F4) → no se
  /// puede confirmar la reserva sobre ella → COBRO_PENDIENTE → CANCELADO. CON Refund (hubo captura, igual que
  /// ASIENTO_LLENO: el dinero se movió y hay que devolverlo · F3c-payment). Defensa contra el poison-pill que
  /// causaría un payment.captured tardío sobre una oferta ya no reservable; el camino EN_RUTA real es F4.
  OFERTA_NO_DISPONIBLE: 'OFERTA_NO_DISPONIBLE',
} as const;
export type BookingCancelledRazon =
  (typeof BookingCancelledRazon)[keyof typeof BookingCancelledRazon];

/// `booking.cancelled` cubre DOS formas distintas que comparten topic/nombre, resueltas de forma ADITIVA
/// (los campos nuevos son OPCIONALES → el caso viejo sigue parseando IGUAL):
///   (A) CANCELACIÓN DE LA OFERTA (PublishedTrip · F1a): el conductor/admin cancela su viaje publicado. Lleva
///       `publishedTripId` + `driverId` + `estadoAnterior` del PublishedTrip. NO lleva `bookingId` ni `razon`.
///       key = publishedTripId. El fan-out de Refund a las reservas activas lo gestiona payment-service.
///   (B) CANCELACIÓN DE UN BOOKING INDIVIDUAL (F3b/F3c · ADR-014 §5.4 / §6): lleva `bookingId` + `razon`
///       (BookingCancelledRazon) + `estadoAnterior`. key = bookingId. TRES sub-formas por `razon`:
///         · COBRO_RECHAZADO (F3b): el cobro síncrono rechazó al disparar el CHARGE → estadoAnterior='APROBADO'.
///           SIN Refund (no se capturó nada).
///         · COBRO_FALLIDO  (F3c): el riel agotó reintentos (payment.failed willRetry=false) →
///           estadoAnterior='COBRO_PENDIENTE'. SIN Refund (no se capturó nada).
///         · ASIENTO_LLENO  (F3c): el cobro CAPTURÓ pero el asiento ya se llenó (§6 camino infeliz) →
///           estadoAnterior='COBRO_PENDIENTE'. ÚNICO caso CON Refund (payment-service devuelve la captura).
/// DECISIÓN (aditiva, no romper): se mantiene UN solo schema con `publishedTripId`/`driverId` OPCIONALES y se
/// AÑADEN `bookingId`/`razon` OPCIONALES. Así el caso (A) existente parsea sin cambios (siempre trae
/// publishedTripId+driverId+estadoAnterior) y el caso (B) nuevo también valida. Un `z.union` discriminado se
/// evaluó pero rompería la firma del payload existente (consumers que asumen `publishedTripId` presente); los
/// campos opcionales son el mínimo cambio que NO toca el camino vivo. `estado` y `estadoAnterior` son comunes.
export const bookingCancelled = z.object({
  /// (A) la oferta cancelada. Presente en la cancelación-de-oferta; ausente en la de booking individual.
  publishedTripId: z.string().optional(),
  /// (A) dueño de la oferta. Presente en la cancelación-de-oferta; ausente en la de booking individual.
  driverId: z.string().optional(),
  /// (B) el booking individual cancelado (F3b · cobro rechazado). Ausente en la cancelación-de-oferta.
  bookingId: z.string().optional(),
  /// (B) por qué se canceló el booking individual (TIPADO). Ausente en la cancelación-de-oferta. F3c añadió
  /// ASIENTO_LLENO (Refund) y COBRO_FALLIDO (sin Refund) a COBRO_RECHAZADO (sin Refund, F3b) — aditivo.
  razon: z
    .enum([
      BookingCancelledRazon.COBRO_RECHAZADO,
      BookingCancelledRazon.ASIENTO_LLENO,
      BookingCancelledRazon.COBRO_FALLIDO,
      BookingCancelledRazon.OFERTA_NO_DISPONIBLE,
    ])
    .optional(),
  estado: z.literal('CANCELADO'),
  /// Estado del que se canceló (auditoría / decisión de Refund downstream). (A) estado del PublishedTrip;
  /// (B) 'APROBADO' (cobro síncrono rechazado, F3b) o 'COBRO_PENDIENTE' (handler de payment.captured/failed, F3c).
  estadoAnterior: z.string(),
});
/// `booking.confirmed` — el cobro CAPTURÓ y el seat-lock atómico (ADR-014 §6) decrementó el asiento:
/// COBRO_PENDIENTE → CONFIRMADO. Lo emite booking-service por OUTBOX en la MISMA tx que el decremento de
/// `asientosDisponibles` (atomicidad estado↔asiento↔evento, §6/§7). Topic 'booking', key = bookingId.
/// Consumidores núcleo (ADR-014 §7.1): notification (recibo), rating (futuro), payout (F5). `paymentId` es la
/// captura que confirmó (correlación con payment-service). Dinero/asientos en Int (céntimos PEN).
export const bookingConfirmed = z.object({
  bookingId: z.string(),
  publishedTripId: z.string(),
  passengerId: z.string(),
  asientos: z.number().int(),
  precioAcordado: z.number().int(), // céntimos PEN
  paymentId: z.string(),
  estado: z.literal('CONFIRMADO'),
});
// Los demás eventos del topic 'booking' (booking.expired/started/completed · ADR-014 §7.1) se DECLARAN al
// implementar F4 (su emisión vive en la fase que la gatilla).

/** Registro central: eventType → schema del payload. */
export const EVENT_SCHEMAS = {
  'user.registered': userRegistered,
  'user.email_verified': userEmailVerified,
  'user.kyc_verified': userKycVerified,
  'user.deletion_requested': userDeletionRequested,
  'user.deleted': userDeleted,
  'admin.role_changed': adminRoleChanged,
  'driver.registered': driverRegistered,
  'driver.verified': driverVerified,
  'driver.rejected': driverRejected,
  'driver.suspended': driverSuspended,
  'driver.resubmitted': driverResubmitted,
  'driver.reactivated': driverReactivated,
  'driver.went_offline': driverWentOffline,
  'driver.went_online': driverWentOnline,
  'driver.excessive_cancellations': driverExcessiveCancellations,
  'biometric.failed': biometricFailed,
  'biometric.enrolled': biometricEnrolled,
  'biometric.enroll_rejected': biometricEnrollRejected,
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
  'pricing.bid_floor_updated': pricingBidFloorUpdated,
  'pricing.base_fare_updated': pricingBaseFareUpdated,
  'driver.location_updated': driverLocationUpdated,
  'driver.entered_zone': driverEnteredZone,
  'media.recording_started': mediaRecordingStarted,
  'media.archived': mediaArchived,
  'media.access_granted': mediaAccessGranted,
  'media.access_rejected': mediaAccessRejected,
  'media.access_viewed': mediaAccessViewed,
  'media.render_completed': mediaRenderCompleted,
  'media.render_failed': mediaRenderFailed,
  'payment.captured': paymentCaptured,
  'payment.failed': paymentFailed,
  'payment.tip_added': paymentTipAdded,
  'payment.cash_pending': paymentCashPending,
  'payment.refunded': paymentRefunded,
  'payment.cancellation_penalty_recorded': cancellationPenaltyRecorded,
  'payment.cancellation_penalty_collected': cancellationPenaltyCollected,
  'payment.affiliation_activated': paymentAffiliationActivated,
  'payment.affiliation_expired': paymentAffiliationExpired,
  'payment.commission_updated': paymentCommissionUpdated,
  'payout.processing': payoutProcessing,
  'payout.processed': payoutProcessed,
  'payout.failed': payoutFailed,
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
  'fleet.document_rejected': fleetDocumentRejected,
  'fleet.driver_suspended': fleetDriverSuspended,
  'fleet.driver_reactivated': fleetDriverReactivated,
  'fleet.vehicle_suspended': fleetVehicleSuspended,
  'fleet.vehicle_registered': fleetVehicleRegistered,
  'fleet.vehicle_model_reviewed': fleetVehicleModelReviewed,
  'booking.published': bookingPublished,
  'booking.requested': bookingRequested,
  'booking.approved': bookingApproved,
  'booking.updated': bookingUpdated,
  'booking.confirmed': bookingConfirmed,
  'booking.cancelled': bookingCancelled,
} as const satisfies Record<string, z.ZodType>;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;

/**
 * OVERRIDES de topic (eventType → topic) que ROMPEN el default "dominio antes del punto".
 *
 * `driver.location_updated` es el FIREHOSE de GPS (un ping por conductor activo cada ~15s, todos los conductores
 * online). Por el default caería en el topic 'driver' JUNTO a los eventos de CICLO DE VIDA de baja frecuencia
 * (driver.verified/rejected/suspended/resubmitted/reactivated/flagged). Eso obliga a CUALQUIER consumer del ciclo
 * de vida (rating-service oye `driver.reactivated`; admin-bff oye varios) a suscribirse al topic 'driver' COMPLETO
 * y, por la REGLA DE ORO (un groupId/consumer = todos sus topics juntos), a DESERIALIZAR el firehose entero solo
 * para descartarlo (no tiene handler). Aislar el firehose en su PROPIO topic deja 'driver' limpio (solo ciclo de
 * vida) para esos consumers, sin que el productor (driver-bff) ni los consumers del firehose (dispatch, public-bff,
 * admin-bff) cambien una línea: TODOS resuelven su topic por esta misma función. Un único punto de routing.
 */
const DRIVER_LOCATION_TOPIC = 'driver-location';
const TOPIC_OVERRIDES: Readonly<Record<string, string>> = {
  'driver.location_updated': DRIVER_LOCATION_TOPIC,
};

/** Topic Kafka para un eventType: override explícito si lo hay; si no, el dominio antes del punto. */
export function topicForEvent(eventType: string): string {
  const override = TOPIC_OVERRIDES[eventType];
  if (override) return override;
  const domain = eventType.split('.')[0];
  // driver.* (excepto el firehose de ubicación, aislado arriba) comparten el topic 'driver': ciclo de vida.
  return domain ?? 'misc';
}

export function schemaForEvent(eventType: string): z.ZodType | undefined {
  return (EVENT_SCHEMAS as Record<string, z.ZodType>)[eventType];
}
