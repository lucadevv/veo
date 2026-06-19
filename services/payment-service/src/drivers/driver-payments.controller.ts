/**
 * Controlador INTERNO del HARD purge del dinero de un conductor (server-to-server). Lo invoca el
 * admin-bff SOLO en DEV durante el purge en cascada (en PROD el guard de historial del admin-bff corta
 * antes y deriva al derecho al olvido BR-S06, que ANONIMIZA vía Kafka, no borra). NO es de cara al
 * usuario: la autorización vive en el BFF + estos guards.
 *
 * Montado bajo el prefijo global `api/v1` → ruta efectiva
 * `DELETE /api/v1/internal/drivers/:driverId/payments?userId=...`.
 *
 * Recibe DOS ids porque payment indexa unas tablas por el id de PERFIL Driver (`:driverId`) y otras por
 * el `User.id` (`?userId=`). El admin-bff (source of truth) provee ambos.
 *
 * GUARDS (orden importa): InternalIdentityGuard PRIMERO verifica la firma HMAC del admin-bff y puebla
 * `req.user` (con sus roles); RolesGuard DESPUÉS valida SUPERADMIN. Espeja fleet/media.
 */
import { Controller, Delete, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';
import { DriverPaymentsService, type DriverPaymentsPurgeView } from './driver-payments.service';

@ApiTags('drivers')
@ApiBearerAuth()
@Controller('internal/drivers')
export class DriverPaymentsController {
  constructor(private readonly driverPayments: DriverPaymentsService) {}

  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @Delete(':driverId/payments')
  @HttpCode(200)
  @ApiQuery({ name: 'userId', required: true, description: 'User.id de identity (indexa 4 tablas por user_id)' })
  @ApiOperation({
    summary:
      'HARD purge del dinero del conductor (5 tablas por driver_id + 4 por user_id). DEV-only. SUPERADMIN.',
  })
  purgePayments(
    @Param('driverId') driverId: string,
    @Query('userId') userId?: string,
  ): Promise<DriverPaymentsPurgeView> {
    if (!userId) {
      throw new ValidationError('userId requerido para el purge del dinero del conductor', {
        field: 'userId',
      });
    }
    return this.driverPayments.purgeForDriver({ driverId, userId });
  }
}
