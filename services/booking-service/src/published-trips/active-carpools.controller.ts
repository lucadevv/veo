/**
 * Endpoint INTERNO admin del MONITOREO de carpools activos (finance/carpooling · panel de monitoreo).
 *
 * Montado bajo el prefijo global `api/v1` → `/api/v1/internal/booking/active-carpools`. Protegido por
 * InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10): lo consume el admin-bff propagando la identidad
 * `admin` firmada. El RBAC FINO (finance:view + overlay) lo aplica el admin-bff; acá solo verificamos que el
 * caller es un servicio interno legítimo (defensa en profundidad). Solo LECTURA (KPIs agregados + listado); no
 * muta nada. Espeja el SearchRadiusController (mismo prefijo `internal/booking`, mismo guard) pero es su propio
 * controller porque su concern es el MONITOREO (no la config del radio de búsqueda).
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { PublishedTripsService, type ActiveCarpoolsView } from './published-trips.service';

@ApiTags('booking')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/booking')
export class ActiveCarpoolsController {
  constructor(private readonly trips: PublishedTripsService) {}

  @Get('active-carpools')
  @ApiOperation({
    summary:
      'Monitoreo de carpools ACTIVOS: KPIs agregados (activos/en ruta/ocupación/cupos) + listado capado. Panel finance/carpooling.',
  })
  activeCarpools(): Promise<ActiveCarpoolsView> {
    return this.trips.listActiveCarpools();
  }
}
