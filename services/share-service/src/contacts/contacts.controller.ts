import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { ContactsService, type ContactView } from './contacts.service';
import { AddContactDto, VerifyContactOtpDto } from './dto/contacts.dto';

@ApiTags('trusted-contacts')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar contactos de confianza del usuario (BR-I06)' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ContactView[]> {
    return this.contacts.list(user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Agregar contacto de confianza (máx 3, envía OTP al contacto)' })
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddContactDto,
  ): Promise<{ contact: ContactView; otpSent: true }> {
    return this.contacts.add(user.userId, dto);
  }

  @Post(':id/verify-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar el OTP del contacto (lo marca como verificado)' })
  verifyOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyContactOtpDto,
  ): Promise<ContactView> {
    return this.contacts.verifyOtp(user.userId, id, dto.code);
  }

  @Post(':id/resend-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenviar el OTP a un contacto pendiente' })
  resendOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ otpSent: true }> {
    return this.contacts.resendOtp(user.userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar contacto de confianza (cool-down de 24h)' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.contacts.remove(user.userId, id);
  }
}
