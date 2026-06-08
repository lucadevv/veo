import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { ReferralsService, type ReferralSummaryView } from './referrals.service';

class RedeemReferralDto {
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  code!: string;
}

@ApiTags('referrals')
@ApiBearerAuth()
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Resumen de referidos del pasajero (código, referidos, créditos)' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<ReferralSummaryView> {
    return this.referrals.summary(user);
  }

  @Post('redeem')
  @HttpCode(200)
  @ApiOperation({ summary: 'Canjear un código de referido (una sola vez, no auto-referirse)' })
  redeem(@CurrentUser() user: AuthenticatedUser, @Body() dto: RedeemReferralDto): Promise<ReferralSummaryView> {
    return this.referrals.redeem(user, dto.code);
  }
}
