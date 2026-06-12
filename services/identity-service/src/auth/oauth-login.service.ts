/**
 * OAuthLoginService — esqueleto COMPARTIDO del login OAuth (ADR-012 §4, Lote A2).
 * GoogleAuthService y AppleAuthService eran gemelos: la misma tx (re-login por sub, linking por
 * correo verificado, alta nueva + outbox) copiada dos veces. Lo ÚNICO polimórfico es la
 * verificación del token del IdP (puerto OAUTH_VERIFIER) y el mapeo de claims → eso queda en cada
 * service; el resto del flujo vive acá UNA vez.
 *
 * Resolución de identidad (en orden, igual para todo IdP):
 *  1. AuthMethod{methodType, oauthSubject=sub} existente → ese User (re-login idempotente).
 *     Cubre el caso Apple: en logins posteriores al primero NO viaja el email, pero buscamos
 *     por `sub` (no por correo), así que el re-login funciona igual.
 *  2. Sin vínculo y email VERIFICADO por el IdP → account-linking por correo verificado
 *     (resolveUserForVerifiedEmail): colgamos la credencial nueva del User existente.
 *  3. Nada de lo anterior → User nuevo (type PASSENGER) + credencial + outbox user.registered
 *     (registerUser: registro transaccional único).
 *
 * Decisión email_verified (seguridad de linking): SOLO vinculamos por correo si el IdP reporta
 * email_verified=true. Si no está verificado, NUNCA fusionamos con una cuenta ajena por email
 * (evita secuestro de cuenta); se permite el login creando/llevando su propia identidad OAuth,
 * pero la credencial queda con emailVerified=false y email=null.
 */
import { Injectable } from '@nestjs/common';
import { type SubjectType } from '@veo/auth';
import { UnauthorizedError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { TokenIssuerService } from './token-issuer.service';
import { resolveUserForVerifiedEmail } from './account-linking';
import { registerUser } from './user-registration';
import type { AuthMethodType, UserType } from '../generated/prisma';
import type { AuthTokens } from './dto/auth.dto';

/** Identidad ya verificada por el puerto OAuth + lo poco que varía por proveedor. */
export interface OAuthLoginInput {
  /** Tipo de credencial del proveedor (el discriminador del vínculo por `sub`). */
  methodType: Extract<AuthMethodType, 'GOOGLE_OAUTH' | 'APPLE_OAUTH'>;
  /** `sub` del IdP: identificador estable del usuario (PK real del vínculo OAuth). */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  /** Nombre del perfil (Google lo manda en el token; Apple nunca → null). */
  name: string | null;
  /** Mensaje del 401 si el estado es inconsistente (User vinculado inexistente). */
  invalidTokenMessage: string;
}

@Injectable()
export class OAuthLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenIssuer: TokenIssuerService,
  ) {}

  /** Resuelve/crea el User en una tx atómica y emite tokens vía TokenIssuerService. */
  async login(input: OAuthLoginInput): Promise<AuthTokens> {
    const { methodType, sub, emailVerified, name } = input;
    const normalizedEmail = input.email ? input.email.trim().toLowerCase() : null;

    const user = await this.prisma.write.$transaction(async (tx) => {
      // 1. Re-login: el vínculo OAuth (por `sub`) ya existe → usamos ese User.
      const existingMethod = await tx.authMethod.findUnique({
        where: { type_oauthSubject: { type: methodType, oauthSubject: sub } },
        include: { user: true },
      });
      if (existingMethod) {
        return existingMethod.user;
      }

      // 2. Account-linking: si el IdP verificó el correo y ese correo ya pertenece a un User
      //    (por otro método verificado), colgamos la credencial nueva de ESE User.
      if (normalizedEmail && emailVerified) {
        const linkedUserId = await resolveUserForVerifiedEmail(tx, normalizedEmail);
        if (linkedUserId) {
          await tx.authMethod.create({
            data: {
              userId: linkedUserId,
              type: methodType,
              oauthSubject: sub,
              email: normalizedEmail,
              emailVerified: true,
              verified: true,
            },
          });
          const linked = await tx.user.findUnique({ where: { id: linkedUserId } });
          if (!linked) throw new UnauthorizedError(input.invalidTokenMessage);
          return linked;
        }
      }

      // 3. Identidad nueva: User PASSENGER + credencial OAuth + outbox user.registered.
      // El email SOLO se persiste en la credencial si el IdP lo verificó. Con
      // email_verified=false NO es de confianza y, además, guardarlo chocaría con
      // @@unique([type, email]) si ya existe otra cuenta del mismo IdP (otro `sub`) con ese
      // mismo correo → P2002 → HTTP 500. La clave única real de la credencial sigue siendo el
      // `sub` (@@unique([type, oauthSubject])). Si el correo estuviese verificado, el path de
      // linking (paso 2) ya lo habría capturado, así que aquí solo persistimos email con
      // verificado=true cuando no hubo User previo con ese correo.
      return registerUser(tx, {
        user: { email: normalizedEmail, name, type: 'PASSENGER' },
        authMethod: {
          type: methodType,
          oauthSubject: sub,
          email: emailVerified ? normalizedEmail : null,
          emailVerified,
          verified: true,
        },
      });
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
