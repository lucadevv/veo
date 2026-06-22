/**
 * Puerto del borde de PAGO de booking-service (INTEGRACIONES · port+adapter · ADR-014 §5.5).
 *
 * El dominio del carpooling habla con payment-service SÓLO por este contrato — NUNCA importa el cliente
 * REST/gRPC ni el SDK (regla madre: el dominio no conoce el transporte). El SDK/HMAC/audiencia viven en los
 * ADAPTERS (`rest-payment-gateway.ts` para los comandos REST firmados, `grpc-payment-reader.ts` para la
 * lectura gRPC), inyectados por DI vía el token `PAYMENT_GATEWAY`. En tests se inyecta un fake del MISMO
 * contrato (`FakePaymentGateway`).
 *
 * Tres operaciones, mapeadas 1:1 al contrato REAL de payment (§5.5, verificado 2026-06-22):
 *  - `charge(input)`   → REST `POST /api/v1/payments/charge` (firmado service-rail · F3b lo INVOCA al aprobar).
 *  - `getDebt(passengerId)` → REST `GET /api/v1/payments/debt` (el gate de deuda al RESERVAR · §5.2 paso 1).
 *  - `getPayment(paymentId)` → gRPC `GetPayment` (lee estado/recibo del cobro ya disparado · §5.4).
 *
 * Estados (PaymentStatus) y métodos (PaymentMethod) son ENUMS TIPADOS reusados de `@veo/shared-types`
 * (fuente única del monorepo) — CERO strings mágicos. El dominio jamás compara contra un literal suelto.
 */
import { PaymentMethod, PaymentStatus } from '@veo/shared-types';

export { PaymentMethod, PaymentStatus };

/** Token DI del puerto de pago. El service depende de ESTE símbolo, no de la clase concreta del adapter. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/**
 * Entrada del CHARGE (§5.5). Dinero SIEMPRE en Int céntimos PEN (nunca float). `tripId = bookingId` (UUID
 * opaco para payment, NO un Trip real — el carpooling no tiene Trip hasta F4). `dedupKey` determinista
 * (`booking-charge:{bookingId}`) → idempotencia financiera: un reintento NO duplica el cobro. `passengerId`
 * = userId del pasajero que paga (server-truth). `method` es un PaymentMethod TIPADO.
 */
export interface ChargeInput {
  /** = bookingId (UUID opaco). payment lo guarda como `tripId` del Payment; el evento lo devuelve para correlacionar. */
  bookingId: string;
  /** Ticket bruto en céntimos PEN (Int). El server de payment valida/recalcula; acá viaja el precio acordado. */
  grossCents: number;
  /** Método de pago TIPADO (YAPE | PLIN | CASH | CARD | PAGOEFECTIVO). */
  method: PaymentMethod;
  /** Pasajero que paga (= userId server-truth). payment lo recibe como `userId`. */
  passengerId: string;
  /** Referencia del pagador en el riel (teléfono/token Yape-Plin). Opcional. */
  payerRef?: string;
  /** Conductor del viaje (para payouts). Opcional. */
  driverId?: string;
}

/**
 * Resultado del CHARGE: el cobro nace ASÍNCRONO (`PENDING` → captura por webhook/poll · §5.1). booking
 * guarda el `paymentId` en el Booking y espera el evento `payment.captured`/`payment.failed`. `status` es un
 * PaymentStatus TIPADO.
 */
export interface ChargeResult {
  paymentId: string;
  status: PaymentStatus;
}

/** Un ítem de deuda del pasajero (cobro en DEBT / penalidad bloqueante). Céntimos PEN. */
export interface DebtItem {
  /** id del Payment en DEBT (ausente en penalidades de cancelación). */
  paymentId?: string;
  /** = bookingId/tripId opaco del cobro. */
  tripId: string;
  amountCents: number;
  reason: string;
  createdAt: string;
}

/**
 * Resumen de deuda del pasajero (§5.4 · gate al reservar). `hasDebt` resume lo BLOQUEANTE; `totalCents`
 * suma sólo las deudas reales. Si `hasDebt` es true, el pasajero NO puede reservar.
 */
export interface DebtSummary {
  hasDebt: boolean;
  totalCents: number;
  items: DebtItem[];
}

/** Vista de lectura de un Payment ya disparado (gRPC GetPayment · §5.4). `found=false` si no existe. */
export interface PaymentView {
  id: string;
  /** = bookingId opaco (el `tripId` del Payment). */
  tripId: string;
  method: PaymentMethod | '';
  status: PaymentStatus | '';
  grossCents: number;
  amountCents: number;
  /** Razón estructurada del fallo del cobro (cuando cayó a DEBT/FAILED); "" si no hubo fallo. */
  failureReason: string;
  found: boolean;
}

export interface PaymentGateway {
  /**
   * Dispara el CHARGE del carpooling (REST firmado service-rail). Idempotente por `dedupKey` derivada del
   * bookingId. Lo INVOCA F3b al aprobar — F3a sólo deja el adapter listo. Lanza ExternalServiceError si
   * payment no responde (el caller decide la compensación).
   */
  charge(input: ChargeInput): Promise<ChargeResult>;

  /**
   * Deuda del pasajero (REST firmado service-rail). El gate de "no puede reservar si tiene deuda" (§5.2
   * paso 1). Lanza ExternalServiceError si payment no responde — el caller decide la degradación (ver
   * BookingsService.reserve: fail-open con observabilidad, porque reservar NO mueve plata).
   */
  getDebt(passengerId: string): Promise<DebtSummary>;

  /**
   * Lee el estado/recibo de un cobro YA disparado por su paymentId (gRPC GetPayment). `found=false` si no
   * existe. Lo usa F3b+ para leer la captura/recibo (la captura en sí llega por evento, no por esta lectura).
   */
  getPayment(paymentId: string): Promise<PaymentView>;
}
