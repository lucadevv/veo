import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * ADR-022 §P-A · Métodos DIGITALES con los que el conductor salda su deuda de comisiones. CASH queda FUERA
 * a propósito: el efectivo se salda por confirmación bilateral con el pasajero presente, no aplica a una
 * deuda acumulada — payment-service lo rechaza con 422. Espejo de `mobileDigitalPaymentMethod` del app.
 */
export const DIGITAL_SETTLE_METHODS = ['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO'] as const;
export type DigitalSettleMethod = (typeof DIGITAL_SETTLE_METHODS)[number];

/**
 * ADR-022 §P-A · Body de `POST /earnings/debt/settle` (driver-bff). Contrato LOCAL del BFF (no toca el DTO
 * interno de payment-service): SOLO el método digital + un `payerRef` opcional. El `driverId` NO viaja en
 * el body — el BFF lo resuelve de la identidad firmada del conductor autenticado (anti-IDOR), y así el
 * conductor solo puede saldar SU propia deuda. CASH → 400 acá (fuera del enum), antes de salir a la red.
 */
export class SettleDebtDto {
  @ApiProperty({
    enum: DIGITAL_SETTLE_METHODS,
    description: 'Método DIGITAL para saldar la deuda (YAPE/PLIN/CARD/PAGOEFECTIVO). CASH → 400.',
  })
  @IsIn(DIGITAL_SETTLE_METHODS)
  method!: DigitalSettleMethod;

  @ApiPropertyOptional({
    description: 'Referencia del pagador en el riel (teléfono/token Yape-Plin), opcional.',
  })
  @IsOptional()
  @IsString()
  payerRef?: string;
}
