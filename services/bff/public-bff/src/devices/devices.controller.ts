import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/device.dto';

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Registrar token de push del pasajero' })
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto): Promise<void> {
    return this.devices.register(user, dto);
  }

  @Delete(':token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar token de push del pasajero' })
  unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    return this.devices.unregister(user, token);
  }
}
