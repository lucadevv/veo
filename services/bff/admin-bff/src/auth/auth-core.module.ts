/**
 * AuthCoreModule (global): cablea @veo/auth en el BFF.
 * El admin-bff es la AUTORIDAD de auth pero trabaja con Bearer JWT (como el resto de BFFs):
 * valida el access token ES256 con la clave PÚBLICA y propaga identidad interna firmada (HMAC) aguas abajo.
 *
 * Provee:
 *  - JWT_SERVICE (solo verificación; el BFF nunca firma access/refresh).
 *  - INTERNAL_IDENTITY_SECRET (para firmar la identidad propagada por gRPC/REST).
 * Los guards globales (Jwt → RateLimit → Roles → StepUpMfa) se registran en AppModule como APP_GUARD.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JwtService,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  generateDevKeyPairPem,
} from '@veo/auth';
import { CLOCK, SystemClock } from '@veo/utils';
import { LOGGER, type Logger } from '@veo/observability';
import type { Env } from '../config/env.schema';

const jwtServiceProvider: Provider = {
  provide: JWT_SERVICE,
  inject: [ConfigService, LOGGER],
  useFactory: async (config: ConfigService<Env, true>, logger: Logger): Promise<JwtService> => {
    let publicPem = config.get('VEO_JWT_PUBLIC_PEM', { infer: true });
    if (!publicPem) {
      if (config.get('NODE_ENV', { infer: true }) === 'production') {
        throw new Error('VEO_JWT_PUBLIC_PEM es obligatorio en producción');
      }
      // Dev/test sin clave provista: generamos un par efímero para que el BFF arranque.
      // Solo validará tokens firmados por esta misma clave (entorno auto-contenido).
      const pair = await generateDevKeyPairPem();
      publicPem = pair.publicPem;
      logger.warn('VEO_JWT_PUBLIC_PEM ausente: usando clave pública efímera de desarrollo');
    }
    return new JwtService({
      privatePem: '', // el BFF no firma; solo verifica con la pública.
      publicPem,
      issuer: config.get('VEO_JWT_ISSUER', { infer: true }),
      audience: config.get('VEO_JWT_AUDIENCE', { infer: true }),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
  },
};

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): string =>
    config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true }),
};

@Global()
@Module({
  // CLOCK: el StepUpMfaGuard (APP_GUARD) depende del puerto Clock por DI; el BFF inyecta el adaptador real.
  providers: [
    jwtServiceProvider,
    internalSecretProvider,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
  exports: [JWT_SERVICE, INTERNAL_IDENTITY_SECRET, CLOCK],
})
export class AuthCoreModule {}
