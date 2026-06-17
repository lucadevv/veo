/**
 * REST interno de afiliación Yape On File. Lo proxya el public-bff en L2 (con identidad firmada).
 * Guard: InternalIdentityGuard (el userId viene de la identidad interna; un usuario solo gestiona LA SUYA).
 * SEGURIDAD: ninguna respuesta incluye walletUid ni PII completa (el servicio devuelve vistas enmascaradas).
 */
import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { AffiliationsService } from './affiliations.service';
import { CreateYapeAffiliationDto } from './dto/affiliations.dto';

@ApiTags('affiliations')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('affiliations/yape')
export class AffiliationsController {
  constructor(private readonly affiliations: AffiliationsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Crear/iniciar afiliación Yape On File. Devuelve deepLink para aprobar en la app Yape',
  })
  create(@Body() dto: CreateYapeAffiliationDto, @CurrentUser() user: AuthenticatedUser) {
    // El deepLink SÍ va al cliente (para abrir Yape). El walletUid NUNCA sale.
    // phone solo viaja en origin=WEB; en MOBILE (default) se omite (deepLink abre Yape directo).
    return this.affiliations.createAffiliation(user.userId, {
      document: dto.document,
      documentType: dto.documentType,
      clientName: dto.clientName,
      origin: dto.origin,
      phone: dto.phone,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Estado de la afiliación Yape del usuario (sin walletUid ni PII completa)',
  })
  async status(@CurrentUser() user: AuthenticatedUser) {
    const view = await this.affiliations.getAffiliationStatus(user.userId);
    return view ?? { status: 'NONE' as const };
  }

  @Delete()
  @ApiOperation({ summary: 'Revocar (baja local) la afiliación Yape del usuario' })
  revoke(@CurrentUser() user: AuthenticatedUser) {
    return this.affiliations.revokeAffiliation(user.userId);
  }
}
