/**
 * API interna de incentivos (Ola 2C). Protegida con InternalIdentityGuard (la llama driver-bff con
 * la identidad firmada del conductor).
 *  - GET /incentives?driverId= → incentivos activos del conductor con su progreso.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audiences, InternalIdentityGuard, AudienceGuard, InternalAudience } from '@veo/auth';
import { IncentivesService } from './incentives.service';
import { DriverIncentiveDto, DriverIncentivesQueryDto } from './dto/incentives.dto';

// Riel del pasajero/conductor (NO service-rail · mínimo privilegio ADR-014 §5.5): declara explícito el set
// previo a F3a para que el AudienceGuard rechace fail-closed a un service-rail (la membresía global ahora
// admite service-rail solo por charge/debt/GetPayment).
const PASSENGER_RAILS = [
  InternalAudience.PUBLIC_RAIL,
  InternalAudience.DRIVER_RAIL,
  InternalAudience.ADMIN_RAIL,
] as const;

@ApiTags('incentives')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(...PASSENGER_RAILS)
@Controller('incentives')
export class IncentivesController {
  constructor(private readonly incentives: IncentivesService) {}

  @Get()
  @ApiOperation({ summary: 'Incentivos activos del conductor con progreso (Ola 2C)' })
  list(@Query() query: DriverIncentivesQueryDto): Promise<DriverIncentiveDto[]> {
    return this.incentives.listForDriver(query.driverId);
  }
}
