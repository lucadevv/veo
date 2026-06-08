/**
 * GoogleAuthService — login con Google OAuth SOBERANO (ADR-012 §4, Lote 3).
 * Verificamos el id_token de Google NOSOTROS contra su JWKS (puerto OAUTH_VERIFIER), sin SaaS de
 * terceros. Tras verificar, resolvemos/creamos el User en una tx atómica y emitimos JWT reusando
 * TokenIssuerService (no duplicamos la lógica de sesión+firma).
 *
 * Resolución de identidad (en orden):
 *  1. AuthMethod{GOOGLE_OAUTH, oauthSubject=sub} existente → ese User (re-login idempotente).
 *  2. Sin vínculo Google y email VERIFICADO por Google → account-linking por correo verificado
 *     (resolveUserForVerifiedEmail): colgamos un AuthMethod{GOOGLE_OAUTH} del User existente.
 *  3. Nada de lo anterior → User nuevo (type PASSENGER) + AuthMethod{GOOGLE_OAUTH} + outbox
 *     user.registered.
 *
 * Decisión email_verified (seguridad de linking): SOLO vinculamos por correo si Google reporta
 * email_verified=true. Si no está verificado, NUNCA fusionamos con una cuenta ajena por email
 * (evita secuestro de cuenta); se permite el login creando/llevando su propia identidad Google,
 * pero la credencial queda con emailVerified=false.
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
export class GoogleAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OAUTH_VERIFIER) private readonly verifier: OAuthVerifier,
    private readonly tokenIssuer: TokenIssuerService,
  ) {}

  /**
   * Login con Google. Verifica el id_token (firma+iss+aud+exp vía puerto), resuelve/crea el User
   * y emite tokens. Token inválido → 401 (lo lanza el verificador).
   */
  async loginWithGoogle(idToken: string): Promise<AuthTokens> {
    const { sub, email, emailVerified, name } = await this.verifier.verifyGoogleIdToken(idToken);
    const normalizedEmail = email ? email.trim().toLowerCase() : null;

    const user = await this.prisma.write.$transaction(async (tx) => {
      // 1. Re-login: el vínculo Google (por `sub`) ya existe → usamos ese User.
      const existingMethod = await tx.authMethod.findUnique({
        where: { type_oauthSubject: { type: 'GOOGLE_OAUTH', oauthSubject: sub } },
        include: { user: true },
      });
      if (existingMethod) {
        return existingMethod.user;
      }

      // 2. Account-linking: si Google verificó el correo y ese correo ya pertenece a un User
      //    (por otro método verificado), colgamos la credencial Google de ESE User.
      if (normalizedEmail && emailVerified) {
        const linkedUserId = await resolveUserForVerifiedEmail(tx, normalizedEmail);
        if (linkedUserId) {
          await tx.authMethod.create({
            data: {
              userId: linkedUserId,
              type: 'GOOGLE_OAUTH',
              oauthSubject: sub,
              email: normalizedEmail,
              emailVerified: true,
              verified: true,
            },
          });
          const linked = await tx.user.findUnique({ where: { id: linkedUserId } });
          if (!linked) throw new UnauthorizedError('token de Google inválido');
          return linked;
        }
      }

      // 3. Identidad nueva: User PASSENGER + credencial Google + outbox user.registered.
      const created = await tx.user.create({
        data: { email: normalizedEmail, name, type: 'PASSENGER' },
      });
      // El email SOLO se persiste en la credencial GOOGLE_OAUTH si Google lo verificó. Con
      // email_verified=false NO es de confianza y, además, guardarlo chocaría con
      // @@unique([type, email]) si ya existe otra cuenta Google (otro `sub`) con ese mismo correo
      // → P2002 → HTTP 500. La clave única real de la credencial sigue siendo el `sub`
      // (@@unique([type, oauthSubject])). Si el correo estuviese verificado, el path de linking
      // (paso 2) ya lo habría capturado, así que aquí solo persistimos email con verificado=true
      // cuando no hubo User previo con ese correo.
      await tx.authMethod.create({
        data: {
          userId: created.id,
          type: 'GOOGLE_OAUTH',
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
