import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import type { FamilyTrackingView, FamilyVideoGrant } from '@veo/api-client';
import { RateLimit } from '../ratelimit/rate-limit.decorator';
import { ShareService } from './share.service';

/** Ventana reutilizada en los límites estrictos de los GET anónimos por token. */
const TEN_MIN = 10 * 60_000;

@ApiTags('public-share')
@Controller('public/share')
export class PublicShareController {
  constructor(private readonly share: ShareService) {}

  // Endpoints @Public anónimos parametrizados por :token → blanco de enumeración/fuerza-bruta de
  // tokens. El rate-limit por IP (la ruta SIEMPRE se incluye en la clave → cubo propio por endpoint)
  // acota el barrido. Efectivo recién con la resolución de IP real del guard (cf-connecting-ip).

  @Public()
  @Get(':token')
  // Anti-enumeración de tokens de seguimiento: 30 cada 10min por IP.
  @RateLimit({ max: 30, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({ summary: 'Vista pública de seguimiento familiar (sin login)' })
  view(@Param('token') token: string): Promise<FamilyTrackingView> {
    return this.share.publicView(token);
  }

  @Public()
  @Get(':token/video')
  // ALTO valor (autorización LiveKit al video EN VIVO del habitáculo): límite duro 10 cada 10min por IP.
  @RateLimit({ max: 10, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({
    summary: 'Autorización de video del habitáculo (LiveKit) para el enlace familiar',
  })
  video(@Param('token') token: string): Promise<FamilyVideoGrant> {
    return this.share.videoGrant(token);
  }
}
