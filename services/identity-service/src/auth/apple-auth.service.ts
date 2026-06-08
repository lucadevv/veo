/**
 * AppleAuthService — login con Sign in with Apple SOBERANO (ADR-012 §4, espejo de GoogleAuthService).
 * Apple es OBLIGATORIO por App Store Guideline 4.8 al ofrecer Google. Verificamos el identityToken
 * de Apple NOSOTROS contra su JWKS (puerto OAUTH_VERIFIER), sin SaaS de terceros. Tras verificar,
 * resolvemos/creamos el User en una tx atómica y emitimos JWT reusando TokenIssuerService.
 *
 * Resolución de identidad (en orden, idéntica a Google):
 *  1. AuthMethod{APPLE_OAUTH, oauthSubject=sub} existente → ese User (re-login idempotente).
 *     Esto cubre el caso típico de Apple: en logins POSTERIORES al primero Apple NO manda el email,
 *     pero como buscamos por `sub` (no por email), el re-login funciona sin necesitar el correo.
 *  2. Sin vínculo Apple y email VERIFICADO por Apple → account-linking por correo verificado
 *     (resolveUserForVerifiedEmail): colgamos un AuthMethod{APPLE_OAUTH} del User existente.
 *  3. Nada de lo anterior → User nuevo (type PASSENGER) + AuthMethod{APPLE_OAUTH} + outbox
 *     user.registered.
 *
 * Decisión email_verified (seguridad de linking): SOLO vinculamos por correo si Apple reporta
 * email_verified=true. Si no está verificado, NUNCA fusionamos con una cuenta ajena por email
 * (evita secuestro de cuenta); se permite el login creando/llevando su propia identidad Apple,
 * pero la credencial queda con emailVerified=false y email=null.
 *
 * Particularidades de Apple frente a Google:
 *  - El email solo viaja en el PRIMER login (relay privado @privaterelay.appleid.com posible). En
 *    logins posteriores no viene; el paso 1 (lookup por sub) ya resuelve el re-login sin email.
 *  - El nombre NUNCA viaja en el token (Apple lo entrega aparte solo la 1ra vez) → name=null.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { type SubjectType } from '@veo/auth';
import { UnauthorizedError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { TokenIssuerService } from './token-issuer.service';
import { resolveUserForVerifiedEmail } from './account-linking';
import { OAUTH_VERIFIER, type OAuthVerifier } from '../ports/oauth/oauth.port';
import { Prisma, type UserType } from '../generated/prisma';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class AppleAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OAUTH_VERIFIER) private readonly verifier: OAuthVerifier,
    private readonly tokenIssuer: TokenIssuerService,
  ) {}

  /**
   * Login con Apple. Verifica el identityToken (firma+iss+aud+exp vía puerto), resuelve/crea el User
   * y emite tokens. Token inválido → 401 (lo lanza el verificador).
   */
  async loginWithApple(identityToken: string): Promise<AuthTokens> {
    const { sub, email, emailVerified } = await this.verifier.verifyAppleIdToken(identityToken);
    const normalizedEmail = email ? email.trim().toLowerCase() : null;

    const user = await this.prisma.write.$transaction(async (tx) => {
      // 1. Re-login: el vínculo Apple (por `sub`) ya existe → usamos ese User. Cubre los logins
      //    posteriores al primero, donde Apple NO manda el email: buscamos por `sub`, no por correo.
      const existingMethod = await tx.authMethod.findUnique({
        where: { type_oauthSubject: { type: 'APPLE_OAUTH', oauthSubject: sub } },
        include: { user: true },
      });
      if (existingMethod) {
        return existingMethod.user;
      }

      // 2. Account-linking: si Apple verificó el correo y ese correo ya pertenece a un User
      //    (por otro método verificado), colgamos la credencial Apple de ESE User.
      if (normalizedEmail && emailVerified) {
        const linkedUserId = await resolveUserForVerifiedEmail(tx, normalizedEmail);
        if (linkedUserId) {
          await tx.authMethod.create({
            data: {
              userId: linkedUserId,
              type: 'APPLE_OAUTH',
              oauthSubject: sub,
              email: normalizedEmail,
              emailVerified: true,
              verified: true,
            },
          });
          const linked = await tx.user.findUnique({ where: { id: linkedUserId } });
          if (!linked) throw new UnauthorizedError('token de Apple inválido');
          return linked;
        }
      }

      // 3. Identidad nueva: User PASSENGER + credencial Apple + outbox user.registered.
      const created = await tx.user.create({
        data: { email: normalizedEmail, name: null, type: 'PASSENGER' },
      });
      // El email SOLO se persiste en la credencial APPLE_OAUTH si Apple lo verificó. Con
      // email_verified=false NO es de confianza y, además, guardarlo chocaría con
      // @@unique([type, email]) si ya existe otra cuenta Apple (otro `sub`) con ese mismo correo
      // → P2002 → HTTP 500. La clave única real de la credencial sigue siendo el `sub`
      // (@@unique([type, oauthSubject])). Si el correo estuviese verificado, el path de linking
      // (paso 2) ya lo habría capturado, así que aquí solo persistimos email con verificado=true
      // cuando no hubo User previo con ese correo.
      await tx.authMethod.create({
        data: {
          userId: created.id,
          type: 'APPLE_OAUTH',
          oauthSubject: sub,
          email: emailVerified ? normalizedEmail : null,
          emailVerified,
          verified: true,
        },
      });
      const envelope = createEnvelope({
        eventType: 'user.registered',
        producer: 'identity-service',
        payload: { userId: created.id, phone: created.phone ?? '', kycStatus: created.kycStatus },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: created.id,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    return this.tokenIssuer.issue(user.id, this.subjectType(user.type), {
      id: user.id,
      phone: user.phone,
      type: user.type,
      kycStatus: user.kycStatus,
      email: user.email,
    });
  }

  private subjectType(type: UserType): SubjectType {
    return type === 'DRIVER' ? 'driver' : 'passenger';
  }
}
