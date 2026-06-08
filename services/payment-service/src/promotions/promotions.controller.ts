/**
 * Endpoints internos de promociones (los llama el BFF por REST firmado; InternalIdentityGuard).
 *  - POST /promotions/validate → previsualiza el descuento de un código sobre una cotización.
 *  - POST /promotions/redeem   → canje idempotente (lo usa el flujo de cobro / pruebas).
 * El cobro real aplica la promo dentro de POST /payments/charge (promoCode opcional).
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { PromotionsService } from './promotions.service';
import {
  RedeemPromoDto,
  ValidatePromoDto,
  type PromoRedemptionView,
  type PromoValidationView,
} from './dto/promotions.dto';

@ApiTags('promotions')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Previsualiza el descuento de un cupón sobre una cotización (no muta)' })
  validate(@Body() dto: ValidatePromoDto): Promise<PromoValidationView> {
    return this.promos.validatePromo(dto.code, dto.userId, dto.fareCents);
  }

  @Post('redeem')
  @HttpCode(200)
  @ApiOperation({ summary: 'Canje idempotente de un cupón para un viaje (un uso por usuario/regla)' })
  redeem(@Body() dto: RedeemPromoDto): Promise<PromoRedemptionView> {
    return this.promos.redeemPromo({
      code: dto.code,
      userId: dto.userId,
      tripId: dto.tripId,
      fareCents: dto.fareCents,
      dedupKey: dto.dedupKey,
    });
  }
}
