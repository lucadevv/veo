/**
 * Registro de tokens de push (interno). Protegido por InternalIdentityGuard: el BFF propaga la
 * identidad firmada del usuario; el userId se toma de ahí (nunca del cuerpo).
 */
import { Body, Controller, Delete, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@ApiTags('devices')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Registrar/actualizar un token de push del usuario autenticado' })
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto): Promise<void> {
    return this.devices.register(user.userId, dto);
  }

  @Delete(':token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar un token de push' })
  unregister(@Param('token') token: string): Promise<void> {
    return this.devices.unregister(token);
  }
}
