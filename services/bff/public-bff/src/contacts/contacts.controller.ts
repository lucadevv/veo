import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { ContactsService } from './contacts.service';
import {
  AddContactDto,
  VerifyContactOtpDto,
  type ContactResource,
  type ContactView,
} from './dto/contacts.dto';

@ApiTags('trusted-contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar contactos de confianza del usuario (BR-I06)' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ContactView[]> {
    return this.contacts.list(user);
  }

  @Post()
  @ApiOperation({ summary: 'Agregar contacto de confianza (máx 3, envía OTP al contacto)' })
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddContactDto,
  ): Promise<{ contact: ContactResource; otpSent: true }> {
    return this.contacts.add(user, dto);
  }

  @Post(':id/verify-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar el OTP del contacto' })
  verifyOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyContactOtpDto,
  ): Promise<ContactResource> {
    return this.contacts.verifyOtp(user, id, dto);
  }

  @Post(':id/resend-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenviar el OTP a un contacto pendiente' })
  resendOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ otpSent: true }> {
    return this.contacts.resendOtp(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar contacto de confianza (cool-down de 24h)' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.contacts.remove(user, id);
  }
}
