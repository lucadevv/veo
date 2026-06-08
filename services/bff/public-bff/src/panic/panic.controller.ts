import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { SkipRateLimit } from '../ratelimit/skip-rate-limit.decorator';
import { PanicService } from './panic.service';
import { TriggerPanicDto, type PanicTriggerResult, type PanicView } from './dto/panic.dto';

@ApiTags('panic')
@ApiBearerAuth()
@Controller('panic')
export class PanicController {
  constructor(private readonly panic: PanicService) {}

  /** BR-S04: disparo de pánico. JAMÁS rate-limited (excluido del rate limiter). Ack rápido (202). */
  @SkipRateLimit()
  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Disparar pánico (BR-S04, idempotente, nunca limitado)' })
  trigger(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TriggerPanicDto,
  ): Promise<PanicTriggerResult> {
    return this.panic.trigger(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado de una alerta de pánico' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicView> {
    return this.panic.getPanic(user, id);
  }
}
