import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { DriverIncentive } from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { IncentivesService } from './incentives.service';

@ApiTags('incentives')
@DriverApi()
@Controller('incentives')
export class IncentivesController {
  constructor(private readonly incentives: IncentivesService) {}

  @Get()
  @ApiOperation({ summary: 'Incentivos activos del conductor con progreso (Ola 2C)' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<DriverIncentive[]> {
    return this.incentives.list(user);
  }
}
