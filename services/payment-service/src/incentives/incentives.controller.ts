/**
 * API interna de incentivos (Ola 2C). Protegida con InternalIdentityGuard (la llama driver-bff con
 * la identidad firmada del conductor).
 *  - GET /incentives?driverId= → incentivos activos del conductor con su progreso.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { IncentivesService } from './incentives.service';
import { DriverIncentiveDto, DriverIncentivesQueryDto } from './dto/incentives.dto';

@ApiTags('incentives')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('incentives')
export class IncentivesController {
  constructor(private readonly incentives: IncentivesService) {}

  @Get()
  @ApiOperation({ summary: 'Incentivos activos del conductor con progreso (Ola 2C)' })
  list(@Query() query: DriverIncentivesQueryDto): Promise<DriverIncentiveDto[]> {
    return this.incentives.listForDriver(query.driverId);
  }
}
