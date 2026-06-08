import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { PaymentMethod } from '@veo/shared-types';
import { DomainError } from '@veo/utils';

/**
 * El pasajero tiene una deuda pendiente (un cobro en DEBT, BR-P02). DECISIÓN DE PRODUCTO: la deuda
 * bloquea TODO pedido de viaje nuevo (no solo el viaje impago) — el pasajero debe saldar antes de
 * volver a pedir. Gate server-side (la app solo refleja): 403 DEBT_PENDING con `{ debtTotalCents,
 * oldestTripId }` → la app muestra el banner y deriva a "saldar". Definido aquí (junto a los DTOs de
 * pago, sin lógica de servicio) para que tanto el gate de trips como el proxy de pagos lo reusen sin
 * crear una dependencia circular entre servicios.
 */
export class DebtPendingError extends DomainError {
  readonly code = 'DEBT_PENDING';
  readonly httpStatus = 403;
  constructor(debtTotalCents: number, oldestTripId: string | null) {
    super('Tienes un pago pendiente. Sáldalo para volver a pedir un viaje.', {
      debtTotalCents,
      oldestTripId,
    });
  }
}

export class ChargeDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje a cobrar' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ description: 'Ticket bruto en céntimos PEN (incluye surge, excluye propina)' })
  @IsInt()
  @Min(0)
  grossCents!: number;

  @ApiPropertyOptional({ description: 'Propina en céntimos PEN (100% al conductor)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  tipCents?: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({ description: 'Referencia del pagador en el riel (teléfono/token Yape/Plin)' })
  @IsOptional()
  @IsString()
  payerRef?: string;

  /**
   * @deprecated Ignorado. El cobro de un viaje es canónico (un solo Payment por viaje): el BFF
   * deriva SIEMPRE la dedupKey de `tripId` (`trip-completed:${tripId}`), el mismo namespace que el
   * cobro nacido del evento `trip.completed`. Aceptar una clave arbitraria reabriría el doble cobro.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignorado: la dedupKey del cobro se deriva del tripId en el servidor (idempotencia por viaje).',
  })
  @IsOptional()
  @IsString()
  dedupKey?: string;
}

/** Métodos DIGITALES admitidos para cambiar el método de un pago pendiente (CASH excluido: se salda bilateral). */
export const DIGITAL_PAYMENT_METHODS = ['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO'] as const;

/**
 * Cambio de método de un pago no-capturado del pasajero (POST /payments/:id/method). DECISIÓN DEL
 * DUEÑO: un pago PENDING/DEBT de un viaje ya hecho puede cambiar de medio (el usuario no pudo pagar
 * el Yape → elige otro DIGITAL). Validación HTTP en el BFF: `IsIn` SOLO digitales — CASH (y cualquier
 * valor fuera de la lista) → 400 antes de tocar el servicio. (El payment-service además devuelve 422
 * para CASH como defensa en profundidad si llegara por otro camino.)
 */
export class ChangeMethodDto {
  @ApiProperty({ enum: DIGITAL_PAYMENT_METHODS, description: 'Nuevo método DIGITAL (YAPE/PLIN/CARD/PAGOEFECTIVO). CASH no se admite.' })
  @IsIn(DIGITAL_PAYMENT_METHODS)
  method!: (typeof DIGITAL_PAYMENT_METHODS)[number];
}

export class CashConfirmDto {
  @ApiPropertyOptional({
    description: 'true = confirma recepción; false = disputa (abre ticket de soporte)',
  })
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export interface PaymentView {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  /** Propina acumulada del viaje (100% al conductor, fuera de comisión). */
  tipCents: number;
  commissionCents: number;
  feeCents: number;
  externalRef: string;
  /**
   * Checkout asíncrono (ProntoPaga · Yape deepLink / QR / PagoEfectivo CIP). Presentes SOLO cuando el
   * cobro espera pago fuera de banda (status PENDING hasta el webhook). `null` para cobros sin checkout
   * (efectivo, on-file ya capturado, sandbox). NUNCA incluye walletUid.
   */
  externalUid: string | null;
  checkoutUrl: string | null;
  /** data-URI del QR (data:image/png;base64,...). */
  qrCode: string | null;
  deepLink: string | null;
  /** Código CIP de PagoEfectivo (pago en agente/banca). */
  cip: string | null;
  /** Caducidad del checkout en ISO-8601. */
  checkoutExpiresAt: string | null;
  /**
   * Razón ESTRUCTURADA del fallo del cobro (cuando el Payment está en DEBT). `null` si no hubo fallo.
   * Formato `method_unavailable:<METHOD>` (p.ej. `method_unavailable:PAGOEFECTIVO`) cuando el método NO
   * está habilitado en el comercio → la app dice "PagoEfectivo no está disponible ahora, elegí otro"
   * en vez del genérico. Otros valores: el motivo del riel (declined, yape_insufficient_funds…).
   */
  failureReason: string | null;
}

/**
 * Clase de un ítem accionable: `DEBT` (cobro en DEBT — bloquea el gate y muestra "Resolver") o
 * `PENDING_ACTION` (cobro PENDING con checkout vivo — "pago por completar", NO bloquea, "Continuar").
 */
export type DebtItemKindView = 'DEBT' | 'PENDING_ACTION';

/** Un ítem accionable del pasajero (cobro en DEBT o PENDING con checkout). Céntimos PEN. */
export interface DebtItemView {
  paymentId: string;
  tripId: string;
  amountCents: number;
  /** Razón del fallo del cobro (saldo insuficiente, declinado…). Vacío en PENDING_ACTION. */
  reason: string;
  /** Fecha de creación del cobro (ISO-8601). */
  createdAt: string;
  /** DEBT (deuda, bloquea) o PENDING_ACTION (pago por completar, no bloquea). */
  kind: DebtItemKindView;
}

/**
 * Resumen accionable del pasajero autenticado (GET /payments/debts). `hasDebt`/`totalCents` resumen
 * SOLO las DEUDAS reales (kind=DEBT) — el gate intacto. `debts` incluye además los PENDING_ACTION.
 */
export interface DebtView {
  hasDebt: boolean;
  /** Suma de las DEUDAS reales (kind=DEBT) en céntimos PEN. 0 si no hay deuda. */
  totalCents: number;
  debts: DebtItemView[];
}
