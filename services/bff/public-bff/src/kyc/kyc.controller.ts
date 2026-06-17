import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { KycService } from './kyc.service';
import { VerifyKycDto, type KycChallengeView, type KycVerificationView } from './dto/kyc.dto';

@ApiTags('kyc')
@ApiBearerAuth()
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir reto de liveness para verificar la identidad del pasajero' })
  challenge(@CurrentUser() user: AuthenticatedUser): Promise<KycChallengeView> {
    return this.kyc.challenge(user);
  }

  @Post('verifications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar liveness del pasajero (liveness OK → VERIFIED)' })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyKycDto,
  ): Promise<KycVerificationView> {
    return this.kyc.verify(user, dto);
  }
}
