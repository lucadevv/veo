/**
 * Endpoints internos de config de pricing editable en caliente. Montados bajo el prefijo global
 * `api/v1` → rutas efectivas `/api/v1/internal/pricing/...`. Protegidos por InternalIdentityGuard
 * (firma HMAC del BFF, FOUNDATION §10). Las MUTACIONES suman DEFENSA EN PROFUNDIDAD server-side
 * (espeja payment-service · CommissionController; NO confía ciegamente en el caller aunque el
 * admin-bff ya gatee en su borde):
 *  - AdminIdentityGuard  → la identidad firmada es de tipo `admin`.
 *  - RolesGuard + @Roles → RBAC `pricing:manage` (FINANCE/ADMIN/SUPERADMIN; excluye SUPPORT/DISPATCHER).
 *  - StepUpMfaGuard + @RequireStepUpMfa → step-up MFA fresca (config comercial/financiera sensible).
 * Los GET/lecturas quedan abiertos a cualquier identidad interna firmada (public-bff los consume para
 * el quote/teaser) — sin @Roles ni step-up.
 *
 * ADR 023: NO hay schedule/franjas de modo (ADR 011 superseded). El modo de pricing vive POR OFERTA en
 * el catálogo (`/internal/catalog`, palanca manual del admin); acá quedan la tarifa base global y el
 * piso de la puja.
 */
import { Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  StepUpMfaGuard,
  Roles,
  RequireStepUpMfa,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { BidFloorService } from './bid-floor.service';
import { BaseFareService } from './base-fare.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceBaseFareDto } from './dto/pricing.dto';
import { ReplaceBidFloorDto } from './dto/bid-floor.dto';

@ApiTags('pricing')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/pricing')
export class PricingController {
  constructor(
    private readonly bidFloor: BidFloorService,
    private readonly baseFare: BaseFareService,
  ) {}

  @Get('base-fare')
  @ApiOperation({
    summary:
      'Tarifa base vigente (banderazo + per-km + per-min en céntimos, o los defaults del código). F2.4',
  })
  getBaseFare() {
    return this.baseFare.getConfig();
  }

  @Put('base-fare')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA la tarifa base (banderazo + per-km + per-min, bump version) y emite ' +
      'pricing.base_fare_updated. pricing:manage (FINANCE/ADMIN/SUPERADMIN) + step-up MFA (F2.4).',
  })
  replaceBaseFare(@Body() dto: ReplaceBaseFareDto) {
    return this.baseFare.replace(
      dto.baseFareCents,
      dto.perKmCents,
      dto.perMinCents,
      dto.expectedVersion,
    );
  }

  @Get('bid-floor')
  @ApiOperation({
    summary:
      'Piso de la PUJA vigente (default + overrides por oferta, o el default S/7). ADR 010 §9.3',
  })
  getBidFloor() {
    return this.bidFloor.getConfig();
  }

  @Put('bid-floor')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el piso de la PUJA (default + overrides por oferta, bump version) y emite ' +
      'pricing.bid_floor_updated. pricing:manage (FINANCE/ADMIN/SUPERADMIN) + step-up MFA (ADR 010 §9.3).',
  })
  replaceBidFloor(@Body() dto: ReplaceBidFloorDto) {
    return this.bidFloor.replace({
      defaultFloorCents: dto.defaultFloorCents,
      overrides: dto.overrides,
      expectedVersion: dto.expectedVersion,
    });
  }
}
