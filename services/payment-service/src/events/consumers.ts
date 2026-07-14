/**
 * Consumidores Kafka del payment-service.
 *  - trip.completed → dispara el cobro del viaje (BR-P01), idempotente por dedupKey determinista.
 *  - driver.flagged → retiene los payouts del conductor en review (BR-P05).
 * Los payloads se validan contra EVENT_SCHEMAS antes de procesarlos.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + log de suscripción derivado del
 * registro) vive promovido en KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId
 * = UN consumer con TODOS sus eventos en `handlers()`. El group de erasure es otro consumer
 * (user-deleted.consumer).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_SCHEMAS,
  isPermanentDataError,
  isUuid,
  processEventOnce,
  type EventDedupOptions,
  type EventEnvelope,
  type EventHandler,
} from '@veo/events';
import { BookingCancelledRazon } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import type { Redis } from '@veo/redis';
import { PaymentsService } from '../payments/payments.service';
import { deriveTripChargeDedupKey } from '../payments/payment.policy';
import { PayoutsService } from '../payouts/payouts.service';
import { IncentivesService } from '../incentives/incentives.service';
import { CreditService } from '../credit/credit.service';
import { REDIS } from '../infra/redis';
import { PaymentMetrics } from '../metrics/payment.metrics';
import type { Env } from '../config/env.schema';
import { classifyRefundError } from './refund-event-classify';

/** clientId kafkajs de este servicio (también su groupId principal de consumo). */
const KAFKA_CLIENT_ID = 'payment-service';
const GROUP_ID = 'payment-service';

/**
 * Namespace Redis de dedup del consumer PRINCIPAL (group `payment-service`). Distinto del de la erasure
 * (`veo:payment:evt:`, otro groupId) — el prefijo aísla por consumer así un eventId procesado por uno NO
 * cuenta como procesado por el otro (@veo/events/dedup). Es la barrera BARATA del refund automático (§2):
 * marca DESPUÉS del éxito (si el handler falla, no se escribe → kafkajs reintenta). La barrera DURA es el
 * `Refund.dedupKey` UNIQUE de `refundForBookingCancellation`.
 */
const PAYMENT_MAIN_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:payment:main-evt:' };

/**
 * Razones de `booking.cancelled` que SÍ disparan refund (hubo CAPTURA · ADR-014 §6). Set TIPADO derivado del
 * enum compartido (cero strings mágicos): el cobro capturó pero el pasajero no viajó → se devuelve. Las otras
 * razones (COBRO_RECHAZADO/COBRO_FALLIDO: charge-on-approval sin hold, nunca se capturó nada) NO refundan.
 */
const REFUNDABLE_CANCELLATION_RAZONES: ReadonlySet<BookingCancelledRazon> = new Set([
  BookingCancelledRazon.ASIENTO_LLENO,
  BookingCancelledRazon.OFERTA_NO_DISPONIBLE,
]);

@Injectable()
export class PaymentEventConsumers extends KafkaConsumerBootstrap {
  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly incentives: IncentivesService,
    private readonly credit: CreditService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly metrics: PaymentMetrics,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /**
   * TODOS los eventos del group, en un solo record (único punto de registro · regla de oro). `booking.cancelled`
   * vive en el MISMO group `payment-service`: registrarlo acá hace que el bootstrap suscriba el topic `booking`
   * (nEvent corta antes del punto) — sin un consumer/group nuevo.
   */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'trip.started': (env) => this.onTripStarted(env),
      'trip.completed': (env) => this.onTripCompleted(env),
      'trip.failed': (env) => this.onTripFailed(env),
      'trip.cancelled': (env) => this.onTripCancelled(env),
      'driver.flagged': (env) => this.onDriverFlagged(env),
      'referral.rewarded': (env) => this.onReferralRewarded(env),
      'booking.cancelled': (env) => this.onBookingCancelled(env),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Consumidores Kafka iniciados (${eventTypes.join(', ')})`;
  }

  /**
   * PREPAGO (ADR-024 · "cobrar al iniciar") · trip.started → dispara el COBRO DIGITAL de la tarifa CONGELADA
   * cuando el conductor toca "Iniciar viaje" (el pasajero ya está a bordo, comprometido). Antes el cobro nacía
   * en trip.completed; ahora nace acá, y trip.completed reusa la MISMA dedupKey → nunca duplica.
   *
   * EFECTIVO: NO se cobra al iniciar (el conductor cobra en mano al terminar, bilateral BR-P03) → no-op acá.
   * Sin `fareCents` (trip.started viejo pre-prepago): tampoco se cobra acá → trip.completed cobra la tarifa
   * completa (fallback honesto en settleTripFareOnCompletion). El resto del hardening (POISON UUID, permanente
   * vs transitorio) es idéntico a onTripCompleted: el cobro es idempotente, reintentar no duplica.
   *
   * FASE 1: el cobro es asíncrono y NO bloquea el start. El gate SÍNCRONO ("si el pago falla, el viaje no
   * avanza") + la UX de "esperando pago" + la afiliación Yape on-file son FASE 2 (ver chargeTripFareAtStart).
   */
  private async onTripStarted(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['trip.started'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('trip.started con payload inválido; descartado');
      return;
    }
    const {
      tripId,
      fareCents,
      driverId,
      passengerId,
      promoCode,
      paymentMethod,
      dispatchMode,
      originLat,
      originLng,
    } = parsed.data;
    // POISON (idéntico a trip.completed): tripId no-UUID toca la columna @db.Uuid → P2023 → loop infinito si
    // se relanza. Descartar sin reintento (el offset avanza).
    if (!isUuid(tripId)) {
      this.logger.error(
        `POISON trip.started: tripId no-UUID "${String(tripId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    // Sin tarifa (trip.started viejo pre-prepago, o evento sin el campo): NO cobramos al iniciar → el cobro
    // caerá completo en trip.completed (fallback). Compat N-2 honesta, no un error.
    if (fareCents === undefined) {
      this.logger.log(
        `trip.started ${tripId} sin fareCents (pre-prepago); el cobro se hará al completar`,
      );
      return;
    }
    try {
      const payment = await this.payments.chargeTripFareAtStart({
        tripId,
        grossCents: fareCents,
        dedupKey: deriveTripChargeDedupKey(tripId),
        driverId,
        // Método del VIAJE: CASH ⇒ chargeTripFareAtStart es no-op (se cobra bilateral en completed); digital
        // ⇒ cobra contra el riel. Ausente ⇒ default del env (nunca cash por omisión).
        method: paymentMethod,
        promoCode,
        userId: passengerId,
        // MÉTRICAS · denorm para los cortes por modo/distrito del panel (igual que en completed).
        dispatchMode,
        originLat,
        originLng,
      });
      this.logger.log(
        payment
          ? `PREPAGO cobro al iniciar viaje ${tripId}: pago ${payment.id} estado ${payment.status}`
          : `PREPAGO viaje ${tripId} EFECTIVO: no se cobra al iniciar (bilateral al completar)`,
      );
    } catch (err) {
      // Misma red de seguridad que onTripCompleted: permanente (P2023/P2009…) → log + saltar (no relanzar);
      // transitorio (DB caída/deadlock/timeout) → relanzar para reintentar (el cobro es idempotente).
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.started: error permanente de datos al cobrar viaje ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló el cobro al iniciar del viaje ${tripId}`);
      throw err; // transitorio → Kafka reintenta; el cobro es idempotente.
    }
  }

  private async onTripCompleted(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['trip.completed'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('trip.completed con payload inválido; descartado');
      return;
    }
    const {
      tripId,
      fareCents,
      driverId,
      passengerId,
      promoCode,
      paymentMethod,
      cashCollected,
      dispatchMode,
      originLat,
      originLng,
    } = parsed.data;
    // HARDENING (incidente dev 2026-06): zod deja pasar `tripId` no-UUID (es `z.string()`, no
    // `.uuid()` — endurecer el schema compartido afecta a TODOS los producers/consumers). Pero la
    // columna `trip_id` es `@db.Uuid`: un id malformado → Prisma P2023 → el catch RELANZABA SIEMPRE →
    // kafkajs reintenta 5 → crash → restart → MISMO offset → loop infinito, partición bloqueada.
    // Guardamos el borde: tripId no-UUID es VENENO → log ERROR + RETURN (saltar, el offset avanza).
    if (!isUuid(tripId)) {
      this.logger.error(
        `POISON trip.completed: tripId no-UUID "${String(tripId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      // PREPAGO (ADR-024 · "cobrar al iniciar"): el cobro DIGITAL de la tarifa ya ocurrió en trip.started →
      // acá NO se re-cobra (misma dedupKey ⇒ idempotente). settleTripFareOnCompletion resuelve los DOS caminos
      // que SÍ quedan en completed: (a) EFECTIVO bilateral (se cobra/confirma en mano al terminar, sin cambio);
      // (b) RECONCILIACIÓN del delta digital (si un waypoint subió la tarifa, cobra SOLO la diferencia).
      const payment = await this.payments.settleTripFareOnCompletion({
        tripId,
        grossCents: fareCents,
        dedupKey: deriveTripChargeDedupKey(tripId),
        driverId,
        // Método del VIAJE (CASH/YAPE/PLIN/CARD): el cobro respeta lo que eligió el pasajero.
        // Si el evento es viejo y no lo trae, settleTripFareOnCompletion cae al default del env.
        method: paymentMethod,
        promoCode,
        userId: passengerId,
        // MÉTRICAS · modo de despacho + origen del viaje (del evento) → payment los denormaliza y zonifica el
        // origen a distrito, para los cortes "Ingresos por modo" (Fijo/Puja) y "por distrito" del panel.
        dispatchMode,
        originLat,
        originLng,
        // EFECTIVO (decisión del dueño): el conductor cobró en mano al terminar (driverConfirmed). Solo
        // significativo si method=CASH; settleTripFareOnCompletion crea la CashConfirmation driverConfirmed=true
        // y emite payment.cash_pending (push al pasajero para que confirme). Ausente/false ⇒ bilateral normal.
        cashCollected,
      });
      this.logger.log(
        payment
          ? `Liquidación de viaje ${tripId}: pago ${payment.id} estado ${payment.status}`
          : `Liquidación de viaje ${tripId}: sin cobro adicional al completar (tarifa ya cobrada al iniciar)`,
      );
    } catch (err) {
      // Red de seguridad: distinguir VENENO de TRANSITORIO. Un error permanente de datos
      // (P2023/P2009/P2000…) NUNCA va a procesar → log ERROR + saltar (NO relanzar). Lo transitorio
      // (DB caída, deadlock, timeout) SÍ se relanza para reintentar; el cobro es idempotente.
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.completed: error permanente de datos al cobrar viaje ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló el cobro del viaje ${tripId}`);
      throw err; // que Kafka reintregue/reintente; el cobro es idempotente.
    }

    // Ola 2C · incentivos: acredita el viaje a los META_VIAJES vigentes del conductor (idempotente
    // por viaje). Independiente del cobro: si falla, no debe revertir el pago ya capturado.
    if (driverId) {
      try {
        await this.incentives.creditTrip(driverId, tripId);
      } catch (err) {
        // Mismo trato que el cobro de arriba: un error PERMANENTE de datos (ids malformados) nunca va a procesar
        // → log + seguir (no reintegrar el pago ya capturado). Uno TRANSITORIO (DB caída/deadlock/timeout) se
        // RE-LANZA para que Kafka reintente el evento — sin esto el crédito de incentivo del viaje se PERDÍA en
        // silencio (el evento se ACKeaba igual). creditTrip es idempotente por viaje → reintentar no duplica (ni
        // re-cobra: la captura de arriba también es idempotente).
        if (isPermanentDataError(err)) {
          this.logger.error(
            { err },
            `POISON incentivos: error permanente al acreditar el viaje ${tripId}; se salta`,
          );
        } else {
          this.logger.error(
            { err },
            `Falló acreditar incentivos del viaje ${tripId}; se reintenta`,
          );
          throw err;
        }
      }
    }
  }

  /**
   * PREPAGO (ADR-024) · trip.failed → REEMBOLSA la tarifa digital ya cobrada al INICIAR cuando el viaje falla
   * (watchdog IN_PROGRESS → FAILED: app del conductor muerta / viaje abandonado). CIERRA el gap que introdujo
   * cobrar al iniciar: sin esto quedaría "pasajero cobrado, viaje fallido, sin refund" (regresión de plata).
   *
   * Reusa el flujo de refund existente (`refundTripFareOnFailure` → executeRefundClaim → reverso real del
   * proveedor), idempotente por `trip-failed-refund:{paymentId}` y NUNCA reporta éxito sin confirmación del
   * proveedor (timeout ≠ falla). Un cobro no capturado (PENDING/DEBT) se CANCELA en vez de reembolsar. CASH no
   * aplica (nunca pasó por el rail). El hardening (POISON UUID, permanente vs transitorio) es el de siempre.
   */
  private async onTripFailed(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['trip.failed'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('trip.failed con payload inválido; descartado');
      return;
    }
    const { tripId } = parsed.data;
    // POISON (idéntico a trip.completed): tripId no-UUID toca la columna @db.Uuid → P2023 → loop infinito si
    // se relanza. Descartar sin reintento.
    if (!isUuid(tripId)) {
      this.logger.error(
        `POISON trip.failed: tripId no-UUID "${String(tripId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      const { refunded, cancelled } = await this.payments.refundTripFareOnFailure(
        tripId,
        `trip-failed: ${parsed.data.fromStatus}`,
      );
      this.logger.log(
        `PREPAGO viaje fallido ${tripId}: ${refunded} cobro(s) reembolsado(s), ${cancelled} cobro(s) cancelado(s)`,
      );
    } catch (err) {
      // Misma red de seguridad que onTripCompleted: permanente (P2023/P2009…) → log + saltar (no relanzar);
      // transitorio (DB caída/deadlock/timeout/reverso 5xx) → relanzar (el refund es idempotente por dedupKey).
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.failed: error permanente al reembolsar el viaje ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló el reembolso del viaje fallido ${tripId}`);
      throw err; // transitorio → Kafka reintenta; el refund es idempotente.
    }
  }

  private async onTripCancelled(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['trip.cancelled'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('trip.cancelled con payload inválido; descartado');
      return;
    }
    const { tripId, penaltyCents, passengerId, driverId, reason } = parsed.data;
    // Sin penalidad → nada que cobrar (canceló el conductor/sistema, o el pasajero dentro de la ventana gratis).
    if (penaltyCents <= 0) return;
    // Para atribuir/cobrar la penalidad necesitamos el pasajero (enriquecido, opcional). Sin él, no se registra.
    if (!passengerId) {
      this.logger.warn(
        `trip.cancelled ${tripId} con penaltyCents=${penaltyCents} pero SIN passengerId; no se registra la penalidad`,
      );
      return;
    }
    // POISON (mismo razonamiento que trip.completed): trip_id/passenger_id son @db.Uuid; ids malformados
    // → P2023 → loop infinito si se relanzan. Saltamos sin reintento.
    if (!isUuid(tripId) || !isUuid(passengerId)) {
      this.logger.error(
        `POISON trip.cancelled: tripId/passengerId no-UUID (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      const res = await this.payments.recordCancellationPenalty({
        tripId,
        passengerId,
        // driverId enriquecido (opcional): si había conductor, cobra su parte del split; si no, todo plataforma.
        driverId: driverId && isUuid(driverId) ? driverId : undefined,
        penaltyCents,
        reason,
      });
      this.logger.log(
        `Penalidad de cancelación del viaje ${tripId}: ${res.penaltyId} (${res.status})`,
      );
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.cancelled: error permanente al registrar la penalidad ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló registrar la penalidad de cancelación del viaje ${tripId}`);
      throw err; // transitorio → Kafka reintenta; recordCancellationPenalty es idempotente.
    }
  }

  private async onDriverFlagged(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['driver.flagged'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('driver.flagged con payload inválido; descartado');
      return;
    }
    await this.payouts.holdDriver(parsed.data.driverId);
    this.logger.log(`Conductor ${parsed.data.driverId} marcado para retención de payouts`);
  }

  /**
   * referral.rewarded → acredita el crédito GASTABLE del referidor (Ola 2A · Lote A). Idempotente por
   * eventId (sourceRef UNIQUE). El crédito ya fue "ganado" en identity (display); acá nace lo gastable que
   * el cobro descuenta en el Lote B.
   */
  private async onReferralRewarded(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['referral.rewarded'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('referral.rewarded con payload inválido; descartado');
      return;
    }
    const { referrerUserId, rewardCents } = parsed.data;
    // POISON (mismo razonamiento que trip.completed): referrerUserId va a la columna user_id @db.Uuid;
    // un id malformado → P2023 → loop infinito si se relanza. Saltamos sin reintento.
    if (!isUuid(referrerUserId)) {
      this.logger.error(
        `POISON referral.rewarded: referrerUserId no-UUID (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      await this.credit.creditFromReferral({
        userId: referrerUserId,
        rewardCents,
        eventId: env.eventId,
      });
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON referral.rewarded: error permanente al acreditar (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló acreditar el crédito de referido (eventId=${env.eventId})`);
      throw err; // transitorio → Kafka reintenta; creditFromReferral es idempotente.
    }
  }

  /**
   * `booking.cancelled` → REFUND AUTOMÁTICO system-initiated del carpooling (F3c-payment · ADR-014 §6 camino
   * infeliz · §9). El ÚLTIMO eslabón: el cobro CAPTURÓ pero el booking se canceló (asiento ya lleno / oferta no
   * reservable) → el pasajero no viajó → se le devuelve TODO, sin operador, automáticamente.
   *
   * Este consumer cubre SOLO la cancelación de un BOOKING individual (forma B del schema: trae `bookingId` +
   * `razon`). La cancelación de la OFERTA (forma A: `publishedTripId`/`driverId`, fan-out de refunds a las
   * reservas activas) es OTRA fase y NO se procesa acá — sin `bookingId`/`razon` el handler retorna (no-op).
   *
   * FILTRO TIPADO por `razon` (cero strings mágicos): SOLO ASIENTO_LLENO y OFERTA_NO_DISPONIBLE refundan (hubo
   * captura). COBRO_RECHAZADO/COBRO_FALLIDO (charge-on-approval sin hold → nunca capturó) y cualquier razón
   * ausente/desconocida → return (no hay nada que devolver).
   *
   * IDEMPOTENCIA DOBLE (§2 · plata real, NO doble-refund):
   *  1. BARATA — `processEventOnce(eventId)`: un re-delivery exacto del MISMO evento ni siquiera entra al refund.
   *     Marca DESPUÉS del éxito (si falla, no se escribe → kafkajs reintenta sin perder la señal).
   *  2. DURA — `Refund.dedupKey` UNIQUE (en refundForBookingCancellation): aunque el dedup expirara o un evento
   *     REORDENADO esquivara la marca, el 2do refund choca contra el UNIQUE → no-op graceful. Una sola plata.
   *
   * Payment no encontrado / ya REFUNDED → `{ skipped }` (caso VÁLIDO bajo at-least-once/reorden) → log + return,
   * NUNCA error (no relanzar: no es una falla).
   *
   * CLASIFICACIÓN DEL ERROR (refund-event-classify · cierra el loop de redelivery ∞ · F3c FIX 3): el catch
   * distingue 4 clases por TIPO/code (cero strings mágicos) para que NINGÚN camino quede en loop ∞ NI sin refund.
   * Se ELIMINÓ el cron re-conductor automático (loopeaba / mataba de hambre): TODO refund REJECTED persistente
   * converge a UN solo camino → marcador durable (la fila Refund REJECTED) + métrica + ALERTA → refund admin manual:
   *  - permanent_data (P2023 UUID inválido…)        → log + return (veneno, no relanzar).
   *  - rejected_settled (gateway rechazó síncrono;   → log warn + return: el Refund ya quedó REJECTED durable en DB
   *    UnprocessableEntityError, Refund REJECTED ya     (rastro que el admin VE); sin reintento automático → refund
   *    persistido)                                      admin manual. La métrica backstop{reason="rejected"} la emite
   *                                                     `rejectRefundAndCompensate` (riel COMÚN síncrono+async), NO acá.
   *  - unrecoverable_no_refund (InvalidStateError:   → métrica backstop{reason="unrecoverable"} + ALERTA + return: el
   *    abortó ANTES de llamar al riel, ya dejó           marcador durable (Refund REJECTED de marca) ya existe; reintentar
   *    un Refund REJECTED de marca)                      loopearía ∞ → refund admin manual.
   *  - transient (DB caída/red/timeout/5xx + CAS)    → relanza (Kafka reintenta; refund idempotente por dedupKey).
   */
  private async onBookingCancelled(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['booking.cancelled'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(
        `booking.cancelled con payload inválido (eventId=${env.eventId}); descartado`,
      );
      return;
    }
    const { bookingId, razon } = parsed.data;

    // Forma A (cancelación de OFERTA): sin bookingId/razon → no es asunto de este refund individual. No-op.
    if (!bookingId || !razon) return;

    // Filtro TIPADO: solo las cancelaciones POST-captura refundan. El resto (sin captura) → no-op.
    if (!REFUNDABLE_CANCELLATION_RAZONES.has(razon)) return;

    // POISON: bookingId va al lookup por `trip_id @db.Uuid` (tripId = bookingId · §5.5). Un id malformado →
    // P2023 → loop infinito si se relanza. Saltamos sin reintento (mismo criterio que trip.completed/cancelled).
    if (!isUuid(bookingId)) {
      this.logger.error(
        `POISON booking.cancelled: bookingId no-UUID "${String(bookingId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }

    try {
      // Barrera BARATA: un re-delivery EXACTO del mismo evento no re-procesa. La barrera DURA (dedupKey UNIQUE)
      // vive dentro de refundForBookingCancellation y cubre el reorden/expiración del dedup.
      await processEventOnce(this.redis, PAYMENT_MAIN_EVENT_DEDUP, env.eventId, async () => {
        const res = await this.payments.refundForBookingCancellation(bookingId, razon);
        if ('skipped' in res) {
          // Caso VÁLIDO bajo at-least-once/reorden (cobro no capturó, ya refunded, o refund ya existente).
          this.logger.log(`Refund de cancelación del booking ${bookingId} omitido: ${res.motivo}`);
          return;
        }
        this.logger.log(
          `Refund automático del booking ${bookingId} (${razon}): refund ${res.refundId} estado ${res.status}`,
        );
      });
    } catch (err) {
      // Clasificación TIPADA (cero strings mágicos · refund-event-classify): NINGÚN camino queda en loop ∞
      // NI sin refund. El loop de redelivery se cerraba acá: un rechazo SÍNCRONO del gateway sube como
      // UnprocessableEntityError (NO permanent-data) → antes se RE-LANZABA → re-entrega ∞ del MISMO evento.
      const action = classifyRefundError(err);
      switch (action) {
        case 'permanent_data':
          // Veneno de datos (P2023 UUID inválido, etc.): el payload NUNCA procesa → log + return (no relanzar).
          this.logger.error(
            { err },
            `POISON booking.cancelled: error permanente al refundar el booking ${bookingId} (eventId=${env.eventId}); descartado sin reintento`,
          );
          return;
        case 'rejected_settled':
          // El gateway rechazó el reverso de forma SÍNCRONA y `rejectRefundAndCompensate` ya dejó el Refund
          // REJECTED PERSISTIDO en DB (el rastro durable que el admin VE en el listado de refunds fallidos).
          // NO hay reintento automático (se eliminó el cron re-conductor: loopeaba/se moría de hambre). El
          // backstop converge a UN solo camino: marca durable (la fila REJECTED) + métrica + alerta → refund
          // admin manual sobre el Payment CAPTURED. El consumer ABSORBE: NO relanzar (sin redelivery Kafka ∞).
          //
          // La métrica `payment_refund_backstop_total{reason="rejected"}` la emite `rejectRefundAndCompensate`
          // (riel COMÚN de transición a REJECTED), NO acá: así cubre TAMBIÉN el rechazo ASÍNCRONO por callback
          // (applyRefundWebhookResult), que NUNCA pasa por este catch (el consumer ya commiteó el offset al ver
          // PENDING). Emitirla acá Y allá DOBLE-CONTARÍA el riel síncrono → se quita de acá. (El `'unrecoverable'`
          // SÍ se emite acá: ese path —persistUnrecoverableRefundMarker— NO pasa por rejectRefundAndCompensate.)
          this.logger.warn(
            { err },
            `BACKSTOP refund del booking ${bookingId}: el gateway RECHAZÓ el reverso (eventId=${env.eventId}); ` +
              `quedó un Refund REJECTED durable en DB → requiere REFUND ADMIN manual (sin reintento automático)`,
          );
          return;
        case 'unrecoverable_no_refund':
          // No-transitorio que abortó ANTES de llamar al riel (gateway sin reembolsos / cobro sin railRef).
          // Reintentar por Kafka loopearía ∞ (la condición es permanente) → ALERTA FUERTE para backstop manual
          // (refund admin). NO loop, NO refund silenciosamente perdido: se SURFACEA. El marcador DURABLE (un
          // Refund REJECTED de marca con failureReason 'unrecoverable:') ya lo dejó `persistUnrecoverableRefundMarker`
          // dentro de refundViaGateway ANTES de lanzar, así que el pasajero NO queda sin rastro. Acá emitimos la
          // métrica SCRAPEABLE que dispara la alerta de ops (una sola vez por evento). Tres trazas: row + métrica + log.
          this.metrics.incRefundBackstop('unrecoverable');
          this.logger.error(
            { err },
            `BACKSTOP refund del booking ${bookingId} (eventId=${env.eventId}): el refund automático falló de forma ` +
              `PERMANENTE (p.ej. el gateway no soporta reembolsos, o el cobro no tiene referencia del riel); quedó un Refund ` +
              `REJECTED durable de marca → requiere REFUND ADMIN manual (sin reintento automático)`,
          );
          return;
        case 'transient':
          // DB caída, red, timeout, deadlock, 5xx no-determinista: el medio falló, el evento es válido → relanzar.
          this.logger.error({ err }, `Falló el refund automático del booking ${bookingId}`);
          throw err; // transitorio → Kafka reintenta; el refund es idempotente (dedupKey UNIQUE + dedup eventId).
      }
    }
  }
}
