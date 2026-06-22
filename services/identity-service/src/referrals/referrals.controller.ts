import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  Audiences,
  AudienceGuard,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { ReferralsService, type ReferralSummary } from './referrals.service';

/** POST /referrals/redeem → body. */
class RedeemReferralDto {
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  code!: string;
}

@ApiTags('referrals')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.PUBLIC_RAIL)
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Resumen de referidos del usuario (código, referidos, créditos)' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<ReferralSummary> {
    return this.referrals.summary(user.userId);
  }

  @Post('redeem')
  @HttpCode(200)
  @ApiOperation({ summary: 'Canjear un código de referido (una sola vez, no auto-referirse)' })
  redeem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RedeemReferralDto,
  ): Promise<ReferralSummary> {
    return this.referrals.applyReferral(user.userId, dto.code);
  }
}
