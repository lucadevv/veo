/**
 * AuthService — proxea los flujos de autenticación admin a identity-service.
 * El BFF NO emite tokens: devuelve al caller (admin-web) los tokens que produce identity, para que
 * admin-web los guarde en su cookie httpOnly en su propio origen.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import { isMfaFresh, type AuthenticatedUser } from '@veo/auth';
import type { SessionUser } from '@veo/api-client';
import { IdentityAuthClient } from './identity-auth.client';
import { REST_IDENTITY } from '../infra/tokens';
import type { LoginDto, TotpConfirmDto, RefreshDto, LogoutDto, RegisterDto } from './dto/auth.dto';

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

@Injectable()
export class AuthService {
  constructor(
    private readonly identityAuth: IdentityAuthClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
  ) {}

  register(dto: RegisterDto): Promise<{ id: string; status: string }> {
    return this.identityAuth.post('/admin/register', dto);
  }

  login(dto: LoginDto): Promise<LoginResult> {
    return this.identityAuth.post('/admin/login', dto);
  }

  totpConfirm(dto: TotpConfirmDto): Promise<AdminTokens> {
    return this.identityAuth.post('/admin/totp/confirm', dto);
  }

  refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.identityAuth.post('/auth/refresh', dto);
  }

  logout(dto: LogoutDto): Promise<{ ok: true }> {
    return this.identityAuth.post('/auth/logout', dto);
  }

  /** Step-up TOTP: requiere Bearer válido; identity re-emite un access con mfaAt fresco. */
  stepUp(identity: AuthenticatedUser, totp: string): Promise<{ accessToken: string }> {
    return this.identityRest.post('/admin/step-up', { identity, body: { totp } });
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
