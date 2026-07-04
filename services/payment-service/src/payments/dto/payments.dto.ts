import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentMethod } from '@veo/shared-types';

export class ChargeDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje a cobrar' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ description: 'Ticket bruto en céntimos PEN (incluye surge, excluye propina)' })
  @IsInt()
  @Min(0)
  grossCents!: number;

  @ApiPropertyOptional({ description: 'Propina en céntimos PEN (100% al conductor)', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  tipCents?: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Referencia del pagador en el riel (teléfono/token Yape-Plin)',
  })
  @IsOptional()
  @IsString()
  payerRef?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Conductor del viaje (para payouts)' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({
    description:
      'Clave de idempotencia (UUIDv7 o derivada). Reintentos con la misma key son idempotentes',
  })
  @IsString()
  dedupKey!: string;

  @ApiPropertyOptional({
    description: 'Código de promoción a aplicar (Ola 2A). Descuenta del total del pasajero',
  })
  @IsOptional()
  @IsString()
  promoCode?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Pasajero que paga (requerido si se envía promoCode)',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

/**
 * Cambio de MÉTODO de un pago no-capturado (POST /payments/:id/method). Solo métodos DIGITALES:
 * CASH se rechaza en el servicio (422) porque el efectivo se salda por confirmación bilateral con el
 * conductor presente (BR-P03), no aplica a un pendiente post-viaje. El `@IsEnum(PaymentMethod)` deja
 * pasar CASH a nivel de sintaxis (es un método válido del enum); el guard de negocio lo bloquea en el
 * servicio con un 422 honesto. No restringimos acá para no acoplar la validación HTTP a la regla de
 * negocio (un 422 con mensaje claro es mejor UX que un 400 "valor no permitido en enum").
 */
export class ChangeMethodDto {
  @ApiProperty({
    enum: PaymentMethod,
    description:
      'Nuevo método DIGITAL de liquidación del pago (YAPE/PLIN/CARD/PAGOEFECTIVO). CASH → 422.',
  })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;
}

/**
 * Query del gate de deuda (GET /payments/debt). El `passengerId` es ON-BEHALF-OF: SÓLO lo respeta el
 * controller cuando el caller es SERVICE_RAIL (booking-service consultando la deuda del pasajero que
 * reserva, que firma identidad anónima de sistema → el passengerId no viaja en la identidad y debe ir
 * explícito). Para los rieles de CLIENTE (public/driver/admin) este campo se IGNORA y el passengerId sale
 * SIEMPRE de la identidad firmada (anti-IDOR: un cliente no puede espiar deuda ajena pasando un query).
 */
export class DebtQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Pasajero cuya deuda se consulta. SOLO se respeta para llamadas de SISTEMA (service-rail, ' +
      'on-behalf-of). Ignorado para rieles de cliente (passengerId = identidad firmada, anti-IDOR).',
  })
  @IsOptional()
  @IsUUID()
  passengerId?: string;
}

export class CashConfirmDto {
  @ApiProperty({ enum: ['driver', 'passenger'], description: 'Quién confirma' })
  @IsEnum({ driver: 'driver', passenger: 'passenger' })
  party!: 'driver' | 'passenger';

  @ApiPropertyOptional({
    description: 'true = confirma (recibí/entregué); false = disputa (dispara ticket de soporte)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class AddTipDto {
  @ApiProperty({ description: 'Propina en céntimos PEN (100% al conductor, fuera de comisión)' })
  @IsInt()
  @Min(1)
  tipCents!: number;

  @ApiProperty({
    description: 'Clave de idempotencia del incremento de propina (UUIDv7 o derivada)',
  })
  @IsString()
  dedupKey!: string;
}

export class EarningsQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Conductor cuyas ganancias se agregan' })
  @IsUUID()
  driverId!: string;

  @ApiProperty({ description: 'Inicio de la ventana (ISO-8601, inclusivo)' })
  @IsString()
  from!: string;

  @ApiProperty({ description: 'Fin de la ventana (ISO-8601, exclusivo)' })
  @IsString()
  to!: string;
}

/**
 * Saldar una penalidad de cancelación (F2.3): el pasajero la paga por el rail. Solo métodos DIGITALES;
 * CASH se rechaza en el servicio (422) — no hay conductor presente para la confirmación bilateral. El
 * `@IsEnum` deja pasar CASH a nivel sintáctico; el guard de negocio lo bloquea con un 422 honesto.
 */
export class SettlePenaltyDto {
  @ApiProperty({
    enum: PaymentMethod,
    description:
      'Método DIGITAL de pago de la penalidad (YAPE/PLIN/CARD/PAGOEFECTIVO). CASH → 422.',
  })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Referencia del pagador en el riel (teléfono/token Yape-Plin)',
  })
  @IsOptional()
  @IsString()
  payerRef?: string;
}

export class RefundDto {
  @ApiProperty({ description: 'Monto a reembolsar en céntimos PEN' })
  @IsInt()
  @Min(1)
  amountCents!: number;

  @ApiProperty({ description: 'Motivo del reembolso (mín. 3 caracteres)' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Gesto explícito del operador "es un reembolso NUEVO, no un reintento": salta el backstop de ventana ' +
      'temporal para permitir un 2do parcial idéntico legítimo (mismo viaje y monto dentro de la ventana).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forceNew?: boolean;

  @ApiPropertyOptional({
    description:
      'RC18 · el refund es por causa ATRIBUIBLE al conductor (viaje no realizado / fraude del conductor). Solo ' +
      'entonces un refund TOTAL de una tarifa digital ya liquidada clawbackea el neto del conductor (se descuenta ' +
      'de su próximo payout). Default false = lo absorbe la plataforma (dispute/fraude del pasajero).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  driverFault?: boolean;
}

/**
 * Clase de un ítem accionable del pasajero (BR-P02):
 *  - `DEBT`: cobro en status=DEBT (los reintentos se agotaron). BLOQUEA pedir un viaje nuevo (gate).
 *  - `PENDING_ACTION`: cobro en status=PENDING con un checkout vivo (ProntoPaga) esperando que el
 *    usuario complete el pago (deepLink Yape / urlPay / QR / CIP). NO es deuda y NO bloquea el gate;
 *    es un "pago por completar" que, si el usuario cerró el sheet, quedaba en un dead-end sin camino
 *    de vuelta. Lo exponemos para que el home ofrezca "Continuar".
 */
export type DebtItemKind = 'DEBT' | 'PENDING_ACTION' | 'CANCELLATION_PENALTY';

/** Un ítem accionable del pasajero (cobro en DEBT/PENDING con checkout, o penalidad de cancelación). Céntimos PEN. */
export interface DebtItem {
  /** id del Payment (DEBT/PENDING_ACTION). Ausente en CANCELLATION_PENALTY (usa `penaltyId`). */
  paymentId?: string;
  /** id de la CancellationPenalty (kind=CANCELLATION_PENALTY). */
  penaltyId?: string;
  tripId: string;
  amountCents: number;
  /** Razón: failureReason del cobro, o el motivo de la cancelación. Vacío en PENDING_ACTION. */
  reason: string;
  createdAt: string;
  /** DEBT y CANCELLATION_PENALTY BLOQUEAN el gate; PENDING_ACTION (pago por completar) NO. */
  kind: DebtItemKind;
}

/**
 * Resumen de ítems accionables del pasajero (BR-P02). `hasDebt` resume SOLO los DEBT (es lo que el
 * gate de nuevos viajes consulta); `totalCents` también suma SOLO los DEBT (el monto que bloquea).
 * `debts` incluye ambos kinds (DEBT primero, luego PENDING_ACTION), de más antiguo a más nuevo dentro
 * de cada grupo, para que el home distinga "deuda" de "pago por completar".
 */
export interface DebtSummary {
  hasDebt: boolean;
  debts: DebtItem[];
  /** Suma de las DEUDAS reales (kind=DEBT) en céntimos PEN. 0 si no hay deuda. Los PENDING_ACTION NO suman. */
  totalCents: number;
}
