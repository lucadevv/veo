/**
 * AuthService — proxea los flujos de autenticación admin a identity-service.
 * El BFF NO emite tokens: devuelve al caller (admin-web) los tokens que produce identity, para que
 * admin-web los guarde en su cookie httpOnly en su propio origen.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import { isMfaFresh, type AuthenticatedUser } from '@veo/auth';
import type { AdminRole } from '@veo/shared-types';
import type { SessionUser } from '@veo/api-client';
import { IdentityAuthClient } from './identity-auth.client';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { REST_IDENTITY } from '../infra/tokens';
import type {
  LoginDto,
  TotpConfirmDto,
  RefreshDto,
  LogoutDto,
  AcceptInviteDto,
} from './dto/auth.dto';

/** Antigüedad máxima (s) de la verificación MFA para considerarla fresca (igual que StepUpMfaGuard). */
const MFA_FRESH_MAX_AGE_SEC = 300;

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; roles: string[] };
}

export interface TotpEnrollChallenge {
  mustEnrollTotp: true;
  otpauthUrl: string;
}

export type LoginResult = AdminTokens | TotpEnrollChallenge;

/** Discrimina el resultado del login: tokens emitidos (acceso real) vs challenge de enrolamiento TOTP. */
function isAdminTokens(result: LoginResult): result is AdminTokens {
  return (result as TotpEnrollChallenge).mustEnrollTotp !== true;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly identityAuth: IdentityAuthClient,
    private readonly audit: AuditRecorder,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
  ) {}

  acceptInvite(dto: AcceptInviteDto): Promise<{ email: string }> {
    return this.identityAuth.post('/admin/invite/accept', dto);
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const result = await this.identityAuth.post<LoginResult>('/admin/login', dto);
    // Solo auditamos un login REAL (tokens emitidos). El challenge de enrolamiento TOTP no es un
    // acceso a la consola todavía, así que se omite.
    if (isAdminTokens(result)) {
      await this.auditSessionEvent(result.admin, 'auth.login', { email: result.admin.email });
    }
    return result;
  }

  async totpConfirm(dto: TotpConfirmDto): Promise<AdminTokens> {
    const tokens = await this.identityAuth.post<AdminTokens>('/admin/totp/confirm', dto);
    await this.auditSessionEvent(tokens.admin, 'auth.totp-enrolled', { email: tokens.admin.email });
    return tokens;
  }

  refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    // refresh: rotación silenciosa de tokens — no es un evento de sesión auditable (no hay decisión
    // humana de acceso), por diseño no se audita.
    return this.identityAuth.post('/auth/refresh', dto);
  }

  logout(dto: LogoutDto): Promise<{ ok: true }> {
    // TODO(audit): logout requiere que identity devuelva el operador. Hoy el LogoutDto solo lleva el
    // refresh token (no el userId del operador), así que no podemos armar un actor para el WORM.
    return this.identityAuth.post('/auth/logout', dto);
  }

  /** Step-up TOTP: requiere Bearer válido; identity re-emite un access con mfaAt fresco. */
  async stepUp(identity: AuthenticatedUser, totp: string): Promise<{ accessToken: string }> {
    const res = await this.identityRest.post<{ accessToken: string }>('/admin/step-up', {
      identity,
      body: { totp },
    });
    // Acá ya tenemos el AuthenticatedUser real (Bearer validado por el guard): lo usamos directo.
    await this.recordSession(identity, 'auth.step-up', identity.userId);
    return res;
  }

  /**
   * Audita un evento de sesión de operador armando un AuthenticatedUser mínimo desde `result.admin`
   * (login/totpConfirm son @Public, pre-auth: no hay identidad firmada por el guard). El actor debe ser
   * válido para que la llamada gRPC firmada (grpcIdentityMetadata → HMAC + aud admin-rail) la acepte el
   * audit-service: por eso `type: 'admin'` + `userId` + `roles` reales; `sessionId: ''` señala honestamente
   * que la sesión recién nace (igual que anonymousIdentity).
   */
  private auditSessionEvent(
    admin: AdminTokens['admin'],
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const actor: AuthenticatedUser = {
      userId: admin.id,
      type: 'admin',
      roles: admin.roles as AdminRole[],
      sessionId: '',
      email: admin.email,
    };
    return this.recordSession(actor, action, admin.id, payload);
  }

  /**
   * fail-OPEN (a propósito, distinto del patrón normal fail-CLOSED de las mutaciones de negocio): si el
   * audit-service está caído, NO bloqueamos el acceso/elevación del operador a la consola — un fail-closed
   * acá sería un lockout TOTAL de operadores ante una caída del WORM. Logueamos a nivel ERROR (severidad
   * alta: hueco de traza que debe alertar) pero seguimos. Las mutaciones de negocio (ops.service) siguen
   * fail-closed; esto es exclusivo para los eventos de SESIÓN.
   */
  private async recordSession(
    actor: AuthenticatedUser,
    action: string,
    resourceId: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.record(actor, { action, resourceType: 'admin', resourceId, payload });
    } catch (err) {
      this.logger.error(
        `audit fail-open: no se registró el evento de sesión '${action}' del operador ${resourceId} (audit-service caído?)`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Vista de sesión derivada del Bearer ya validado por JwtAuthGuard. */
  session(user: AuthenticatedUser): SessionUser {
    return {
      userId: user.userId,
      type: user.type,
      roles: user.roles,
      mfaFresh: isMfaFresh(user.mfaVerifiedAt, MFA_FRESH_MAX_AGE_SEC),
    };
  }
}
