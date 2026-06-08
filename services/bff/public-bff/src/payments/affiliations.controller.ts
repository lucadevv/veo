/**
 * Afiliación Yape On File del pasajero (proxy público L2). Ruta: /api/v1/payments/affiliations/yape.
 * Auth: JwtAuthGuard global → el userId SIEMPRE sale del JWT (anti-IDOR: el cliente no puede afiliar a
 * otro usuario). El BFF valida el body (class-validator) y delega al payment-service con identidad firmada.
 */
import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { AffiliationsService } from './affiliations.service';
import { CreateYapeAffiliationDto, type YapeAffiliationView } from './dto/affiliations.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments/affiliations/yape')
export class AffiliationsController {
  constructor(private readonly affiliations: AffiliationsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Crear/iniciar la afiliación Yape On File del pasajero. Devuelve deepLink para aprobar en la app Yape.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateYapeAffiliationDto,
  ): Promise<YapeAffiliationView> {
    return this.affiliations.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Estado de la afiliación Yape del pasajero (sin walletUid ni PII completa). status:NONE si no afilió.',
  })
  status(@CurrentUser() user: AuthenticatedUser): Promise<YapeAffiliationView> {
    return this.affiliations.status(user);
  }

  @Delete()
  @ApiOperation({ summary: 'Revocar (baja local) la afiliación Yape del pasajero.' })
  revoke(@CurrentUser() user: AuthenticatedUser): Promise<YapeAffiliationView> {
    return this.affiliations.revoke(user);
  }
}
