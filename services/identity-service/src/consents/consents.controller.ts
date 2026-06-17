import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { ConsentsService, type ConsentView } from './consents.service';

/**
 * Body del registro de consentimiento. El `userId` NO viaja aquí: se resuelve desde la identidad
 * interna firmada (header HMAC propagado por el BFF). La `ip` la añade el BFF desde el request.
 */
class RecordConsentDto {
  @IsBoolean()
  dataProcessing!: boolean;

  @IsBoolean()
  inCabinCamera!: boolean;

  @IsBoolean()
  location!: boolean;

  @IsBoolean()
  marketing!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  policyVersion!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;

  /** Clave de idempotencia (UUIDv7) del cliente; el doble submit con la misma key es no-op. */
  @IsOptional()
  @IsUUID()
  dedupKey?: string;
}

@ApiTags('users-consents')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('users/consents')
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Consentimiento VIGENTE del pasajero (el más reciente; null si nunca registró)',
  })
  current(@CurrentUser() user: AuthenticatedUser): Promise<ConsentView | null> {
    return this.consents.getCurrent(user.userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar un consentimiento del pasajero (Ley 29733, append-only)' })
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecordConsentDto,
  ): Promise<ConsentView> {
    return this.consents.record(user.userId, {
      dataProcessing: dto.dataProcessing,
      inCabinCamera: dto.inCabinCamera,
      location: dto.location,
      marketing: dto.marketing,
      policyVersion: dto.policyVersion,
      ip: dto.ip ?? null,
      dedupKey: dto.dedupKey,
    });
  }
}
