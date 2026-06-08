import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { KycService } from './kyc.service';

class VerifyKycDto {
  @IsString()
  challengeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  frames!: string[];
}

@ApiTags('users-kyc')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('users/kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir reto de liveness para el KYC del pasajero' })
  challenge(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.createChallenge(user.userId);
  }

  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar liveness del pasajero (liveness OK → kycStatus VERIFIED)' })
  verify(@CurrentUser() user: AuthenticatedUser, @Body() dto: VerifyKycDto) {
    return this.kyc.verify(user.userId, dto);
  }
}
