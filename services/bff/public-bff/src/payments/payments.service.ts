/**
 * Pagos del pasajero. Cobro y confirmación de efectivo son comandos (REST interno firmado);
 * la consulta de un pago es lectura (gRPC GetPayment). En el BFF de pasajero el actor de la
 * confirmación de efectivo es siempre 'passenger'.
 */
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { grpcIdentityMetadata, INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { NotFoundError } from '@veo/utils';
import { GRPC_PAYMENT, GRPC_TRIP, REST_PAYMENT } from '../infra/downstream.tokens';
import { REDIS } from '../infra/redis';
import type { PaymentReply, TripReply, UserCreditReply } from '../infra/grpc-types';
import {
  type CashConfirmDto,
  type ChargeDto,
  type DebtView,
  type PaymentView,
} from './dto/payments.dto';
import type { DebtSummaryReply } from './payments.types';

/**
 * Clave de idempotencia DETERMINISTA del cobro por viaje. DEBE coincidir byte-a-byte con
 * payment-service `deriveTripChargeDedupKey` (payments/payment.policy.ts), porque es el namespace
 * único del cobro canónico del viaje: tanto el evento `trip.completed` como este cobro manual del
 * pasajero deben producir la MISMA dedupKey para colisionar en el UNIQUE de Payment.dedupKey y no
 * generar un doble cobro. No se importa desde payment-service (frontera de microservicios, regla #2);
 * el FORMATO `trip-completed:${tripId}` es el contrato compartido. Si cambia allá, cambia aquí.
 */
function deriveTripChargeDedupKey(tripId: string): string {
  return `trip-completed:${tripId}`;
}

/** proto3 entrega "" para strings ausentes; el recibo público distingue null ↔ valor. */
function blankToNull(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === '' ? null : v;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(GRPC_PAYMENT) private readonly paymentGrpc: GrpcServiceClient,
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  charge(user: AuthenticatedUser, dto: ChargeDto): Promise<PaymentView> {
    // MONEY PATH — idempotencia por VIAJE.
    // El cobro de un viaje es canónico: existe UN solo Payment por viaje. El cobro nace
    // normalmente del evento `trip.completed` (payment-service consumer) con la dedupKey
    // determinista `trip-completed:${tripId}`. Si el pasajero dispara además este cobro manual,
    // DEBE caer en EXACTAMENTE la misma dedupKey para chocar contra el UNIQUE de Payment.dedupKey
    // y devolver el pago existente en vez de crear un segundo (doble cobro).
    //
    // Por eso NO usamos la dedupKey arbitraria del cliente ni un uuidv7() aleatorio: ambos abrirían
    // namespaces distintos y romperían la colisión. Derivamos SIEMPRE del tripId, replicando el
    // formato de payment-service `deriveTripChargeDedupKey` (payment.policy.ts). No se importa esa
    // función: cruzaría la frontera de microservicios (regla #2). El formato es el contrato compartido.
    const dedupKey = deriveTripChargeDedupKey(dto.tripId);
    return this.paymentRest.post<PaymentView>('/payments/charge', {
      identity: user,
      idempotencyKey: dedupKey,
      body: {
        tripId: dto.tripId,
        grossCents: dto.grossCents,
        tipCents: dto.tipCents,
        method: dto.method,
        payerRef: dto.payerRef,
        dedupKey,
      },
    });
  }

  async getPayment(user: AuthenticatedUser, id: string): Promise<PaymentView> {
    // ANTI-IDOR/anti-enumeración OBLIGATORIO: el gRPC GetPayment es getter CRUDO por id (el contrato deja
    // el ownership al BFF). Verificamos PRIMERO que el cobro es del pasajero autenticado leyéndolo por REST
    // interno (trae passengerId); ajeno/inexistente → 404 (no 403, no filtra existencia). Mismo gate que
    // retryCharge/changeMethod. Sin esto, cualquier id devolvía monto/método/externalRef de un pago ajeno.
    let owner: { passengerId?: string | null };
    try {
      owner = await this.paymentRest.get<{ passengerId?: string | null }>(`/payments/${id}`, {
        identity: user,
      });
    } catch {
      throw new NotFoundError('Pago no encontrado');
    }
    if (!owner.passengerId || owner.passengerId !== user.userId) {
      throw new NotFoundError('Pago no encontrado');
    }
    return this.fetchPaymentView(user, id);
  }

  /**
   * Resuelve el PaymentView por gRPC (GetPayment) SIN re-chequear ownership. Lo usan getPayment (que
   * pone el gate anti-IDOR encima) y confirmCash (cuyo comando interno YA verificó al pasajero por la
   * identidad firmada). NO exponer directo a una ruta sin gate previo.
   */
  private async fetchPaymentView(user: AuthenticatedUser, id: string): Promise<PaymentView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.paymentGrpc.call<PaymentReply>('GetPayment', { id }, meta);
    return this.toPaymentView(reply);
  }

  /**
   * Cobro de un viaje por tripId (re-entrada del recibo). ANTI-IDOR OBLIGATORIO: verificamos PRIMERO
   * que el viaje pertenezca al pasajero autenticado (GetTrip por gRPC → 404 si no es suyo, mismo gate
   * que trips.tip/videoGrant), y SOLO entonces resolvemos su cobro canónico (GetPaymentByTrip, por la
   * dedupKey determinista). Un viaje ajeno → 404 (no se filtra existencia). Si el viaje aún no tiene
   * cobro (found=false) → 404 'Pago no encontrado'.
   */
  async getPaymentByTrip(user: AuthenticatedUser, tripId: string): Promise<PaymentView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      // Ajeno → 404 (no 403): no filtramos que el viaje exista para otro pasajero (anti-enumeración).
      throw new NotFoundError('Viaje no encontrado');
    }
    const reply = await this.paymentGrpc.call<PaymentReply>('GetPaymentByTrip', { tripId }, meta);
    if (!reply.found) throw new NotFoundError('Pago no encontrado');
    return this.toPaymentView(reply);
  }

  /**
   * Saldo de crédito GASTABLE del pasajero (redención de referidos · Ola 2A · Lote C). El cobro ya lo
   * aplica solo (Lote B); esto es para que la app MUESTRE "tenés S/X de crédito". ANTI-IDOR: el userId es
   * el del JWT autenticado, nunca uno del cliente → el pasajero solo ve SU saldo.
   */
  async getUserCredit(user: AuthenticatedUser): Promise<{ balanceCents: number }> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.paymentGrpc.call<UserCreditReply>(
      'GetUserCredit',
      { userId: user.userId },
      meta,
    );
    return { balanceCents: reply.balanceCents };
  }

  /** Mapea la respuesta gRPC PaymentReply a la vista pública del pasajero. */
  private toPaymentView(reply: PaymentReply): PaymentView {
    return {
      id: reply.id,
      tripId: reply.tripId,
      method: reply.method,
      status: reply.status,
      amountCents: reply.amountCents,
      grossCents: reply.grossCents,
      tipCents: reply.tipCents,
      commissionCents: reply.commissionCents,
      feeCents: reply.feeCents,
      externalRef: reply.externalRef ?? '',
      // Checkout asíncrono (ProntoPaga): proto3 entrega "" cuando la columna es null. Re-mapeamos a
      // null para que el recibo NO muestre campos vacíos (la app distingue null ↔ "hay checkout").
      externalUid: blankToNull(reply.externalUid),
      checkoutUrl: blankToNull(reply.checkoutUrl),
      qrCode: blankToNull(reply.qrCode),
      deepLink: blankToNull(reply.deepLink),
      cip: blankToNull(reply.cip),
      checkoutExpiresAt: blankToNull(reply.checkoutExpiresAt),
      // Razón del fallo del cobro: "" (gRPC) o null (Payment REST sin fallo) → null. Cuando hay DEBT por
      // método no habilitado llega `method_unavailable:<METHOD>` y la app lo muestra honesto por-método.
      failureReason: blankToNull(reply.failureReason),
    };
  }

  /**
   * Confirma el lado del PASAJERO en el efectivo (confirmación bilateral). El comando interno
   * (`POST /payments/:id/cash/confirm`) devuelve SOLO el estado de la confirmación
   * (`{ tripId, driverConfirmed, passengerConfirmed, status }`), NO un `PaymentView` completo. Si
   * devolviéramos ESO tipado como `PaymentView`, la app lo parsea con el schema `paymentView` (zod) y
   * REVIENTA: faltan `id`, `method`, `amountCents`, `externalRef`, etc. — el confirm respondía 200 pero
   * la app mostraba "error" (el zod-parse del 200 lanzaba). Por eso, tras confirmar, RE-LEEMOS el cobro
   * canónico (GetPayment gRPC) y devolvemos el `PaymentView` completo por el MISMO mapeo público
   * (`toPaymentView` → `blankToNull`), idéntico a `getPayment`/`getPaymentByTrip`. Así el shape del 200
   * del confirm es el contrato que la app espera y el estado bilateral ya viene reflejado en el Payment.
   */
  async confirmCash(
    user: AuthenticatedUser,
    id: string,
    dto: CashConfirmDto,
  ): Promise<PaymentView> {
    await this.paymentRest.post<unknown>(`/payments/${id}/cash/confirm`, {
      identity: user,
      body: { party: 'passenger', confirmed: dto.confirmed ?? true },
    });
    // El comando interno YA verificó al pasajero (identidad firmada) → fetchPaymentView sin re-chequear
    // ownership (getPayment lo re-chequearía con un REST extra, redundante acá).
    return this.fetchPaymentView(user, id);
  }

  /**
   * Deudas del pasajero autenticado (para el banner de la app). Lectura directa del cobro canónico:
   * el passengerId sale de la identidad firmada en payment-service (no se pasa parámetro → anti-IDOR).
   */
  async getMyDebts(user: AuthenticatedUser): Promise<DebtView> {
    const summary = await this.paymentRest.get<DebtSummaryReply>('/payments/debt', {
      identity: user,
    });
    return {
      hasDebt: summary.hasDebt,
      totalCents: summary.totalCents,
      debts: summary.debts.map((d) => ({
        paymentId: d.paymentId,
        penaltyId: d.penaltyId,
        tripId: d.tripId,
        amountCents: d.amountCents,
        reason: d.reason,
        createdAt: d.createdAt,
        // Defensivo: un payment-service viejo sin `kind` se trata como DEBT (comportamiento anterior).
        kind: d.kind ?? 'DEBT',
      })),
    };
  }

  /**
   * Saldar una deuda: re-cobra un Payment en DEBT. ANTI-IDOR/anti-enumeración OBLIGATORIO: leemos el
   * cobro por REST interno y verificamos que `passengerId === user.userId` ANTES de re-cobrar; un cobro
   * ajeno o inexistente → 404 (no 403, para no filtrar que el pago existe para otro). Solo entonces
   * disparamos el re-cobro (payment-service es idempotente y concurrencia-seguro). Tras saldar,
   * invalidamos el cache "sin deuda" para no servir un estado viejo. Devuelve el PaymentView resultante
   * (prontopaga → PENDING con checkout nuevo; sandbox → CAPTURED o de vuelta a DEBT).
   */
  async retryCharge(user: AuthenticatedUser, id: string): Promise<PaymentView> {
    // 1) Ownership: leemos el Payment (con passengerId) por REST interno. Ajeno/inexistente → 404.
    let owner: { passengerId?: string | null };
    try {
      owner = await this.paymentRest.get<{ passengerId?: string | null }>(`/payments/${id}`, {
        identity: user,
      });
    } catch {
      throw new NotFoundError('Pago no encontrado');
    }
    if (!owner.passengerId || owner.passengerId !== user.userId) {
      throw new NotFoundError('Pago no encontrado'); // anti-enumeración
    }
    // 2) Re-cobro (idempotente aguas abajo). El gate volverá a consultar payment en el próximo viaje.
    const updated = await this.paymentRest.post<PaymentReply>(`/payments/${id}/retry-charge`, {
      identity: user,
    });
    // Invalidamos el cache "sin deuda" del gate: el estado de deuda cambió (puede haberse saldado).
    try {
      await this.redis.del(`debt:none:${user.userId}`);
    } catch {
      // best-effort.
    }
    return this.toPaymentView(updated);
  }

  /**
   * F2.3 · Pagar una penalidad de cancelación: la salda "como un DEBT" por el rail. NO necesita el
   * pre-check de ownership del BFF (a diferencia de retryCharge/changeMethod, que operan sobre un Payment
   * por id): payment-service resuelve la penalidad por el `passengerId` FIRMADO de la identidad interna
   * y devuelve 404 si la penalidad es ajena (anti-IDOR/anti-enumeración en la fuente). Tras saldar,
   * invalidamos el cache "sin deuda" del gate (la penalidad pudo pasar a COLLECTED → el gate se libera).
   * Devuelve el PaymentView del cobro de liquidación (sandbox→CAPTURED; prontopaga→PENDING con checkout).
   */
  async settlePenalty(
    user: AuthenticatedUser,
    penaltyId: string,
    method: string,
    payerRef?: string,
  ): Promise<PaymentView> {
    const settlement = await this.paymentRest.post<PaymentReply>(
      `/payments/penalties/${penaltyId}/settle`,
      {
        identity: user,
        body: { method, payerRef },
      },
    );
    // El estado de deuda cambió (penalidad bloqueante → potencialmente COLLECTED). El gate reconsulta.
    try {
      await this.redis.del(`debt:none:${user.userId}`);
    } catch {
      // best-effort.
    }
    return this.toPaymentView(settlement);
  }

  /**
   * Cambiar el MÉTODO de un pago no-capturado del pasajero (el usuario no pudo pagar el Yape → elige
   * otro DIGITAL). MISMO patrón anti-IDOR que retryCharge: leemos el cobro por REST interno y validamos
   * `passengerId === user.userId` ANTES de cambiar; un cobro ajeno o inexistente → 404 (no 403, para no
   * filtrar que el pago existe para otro). Solo entonces disparamos el cambio en payment-service (que
   * vuelve a guardar estado/método y re-cobra; idempotente y concurrencia-seguro). Tras el cambio
   * invalidamos el cache "sin deuda" (un DEBT pudo pasar a PENDING). Devuelve el PaymentView resultante
   * (prontopaga → PENDING con checkout NUEVO del método nuevo; sandbox → CAPTURED o de vuelta a DEBT).
   * El método pertenece al Payment (cómo se liquida AHORA), NO al Trip (lo elegido al pedir, histórico).
   */
  async changeMethod(user: AuthenticatedUser, id: string, method: string): Promise<PaymentView> {
    // 1) Ownership: leemos el Payment (con passengerId) por REST interno. Ajeno/inexistente → 404.
    let owner: { passengerId?: string | null };
    try {
      owner = await this.paymentRest.get<{ passengerId?: string | null }>(`/payments/${id}`, {
        identity: user,
      });
    } catch {
      throw new NotFoundError('Pago no encontrado');
    }
    if (!owner.passengerId || owner.passengerId !== user.userId) {
      throw new NotFoundError('Pago no encontrado'); // anti-enumeración
    }
    // 2) Cambio de método (idempotente/concurrencia-seguro aguas abajo). El servicio guarda el estado
    //    (409 si CAPTURED/REFUNDED), rechaza CASH (422) y re-cobra con el método nuevo.
    const updated = await this.paymentRest.post<PaymentReply>(`/payments/${id}/method`, {
      identity: user,
      body: { method },
    });
    // Invalidamos el cache "sin deuda" del gate: un DEBT pudo normalizarse a PENDING al re-cobrar.
    try {
      await this.redis.del(`debt:none:${user.userId}`);
    } catch {
      // best-effort.
    }
    return this.toPaymentView(updated);
  }
}
