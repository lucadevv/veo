/**
 * AuthService — login con teléfono + OTP (pasajero/conductor), emisión de JWT ES256,
 * rotación de refresh (Redis) y logout. Crea el User en su primer login y emite user.registered.
 */
import { Inject, Injectable } from '@nestjs/common';
import { JwtService, RedisRefreshTokenStore, RefreshError, type SubjectType } from '@veo/auth';
import { ForbiddenError, parseOrThrow, peruPhoneSchema, UnauthorizedError } from '@veo/utils';
import { type AdminRole } from '@veo/shared-types';
import { AuthRepository } from './auth.repository';
import { OtpService } from './otp.service';
import { TokenIssuerService } from './token-issuer.service';
import { registerUser } from './user-registration';
import { isOperationalAdmin } from '../domain/admin-status';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import { type UserType } from '../generated/prisma';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly otp: OtpService,
    private readonly jwt: JwtService,
    private readonly sessions: RedisRefreshTokenStore,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    private readonly tokenIssuer: TokenIssuerService,
  ) {}

  /** Solicita un OTP y lo envía por SMS. */
  async requestOtp(rawPhone: string): Promise<{ sent: true }> {
    const phone = parseOrThrow(peruPhoneSchema, rawPhone, 'phone');
    const code = await this.otp.issue(phone);
    await this.sms.send(phone, `Tu código VEO es ${code}. Válido 5 minutos. No lo compartas.`);
    return { sent: true };
  }

  /** Verifica el OTP, crea/recupera el usuario y emite tokens. */
  async verifyOtp(rawPhone: string, code: string, type: UserType): Promise<AuthTokens> {
    const phone = parseOrThrow(peruPhoneSchema, rawPhone, 'phone');
    await this.otp.verify(phone, code);

    const user = await this.repo.runInTransaction(async (tx) => {
      const existing = await this.repo.findUserByPhoneTx(tx, phone);
      if (existing) {
        // Asegurar el AuthMethod{PHONE_OTP} de usuarios previos (idempotente, ADR-012 Lote 1).
        await this.repo.ensurePhoneOtpAuthMethodTx(tx, existing.id);
        return existing;
      }
      // Alta nueva: User + credencial PHONE_OTP (ADR-012 §2) + outbox user.registered, vía el
      // registro transaccional único (Lote A2).
      return registerUser(tx, {
        user: { phone, type },
        authMethod: { type: 'PHONE_OTP', verified: true },
      });
    });

    // M7 — GATE DE TIPO DE CUENTA (fail-closed): el `type` pedido (que el BFF fuerza: 'DRIVER' desde driver-bff)
    // se ignoraba para un user EXISTENTE → un teléfono registrado como PASAJERO que entraba por driver-bff recibía
    // un token typ=passenger y la app de conductor quedaba rota (DriverTypeGuard 403 en todo). Un User tiene UN
    // solo tipo; si el existente NO coincide con el pedido, se RECHAZA con error tipado (403) — no se emite un
    // token del tipo equivocado. La conversión de cuenta (pasajero↔conductor) es un flujo aparte, no un login.
    // Para un alta nueva `user.type === type` (recién creado), así que este gate solo muerde el mismatch real.
    if (user.type !== type) {
      throw new ForbiddenError(
        'Este teléfono está registrado con otro tipo de cuenta. Ingresá desde la app correspondiente.',
      );
    }

    const subject = this.subjectType(user.type);
    // SINGLE ACTIVE SESSION para el CONDUCTOR (el último login gana): revocamos las sesiones previas ANTES de
    // emitir la nueva. Seguridad — el diferenciador biométrico POR TURNO se rompe si el MISMO login publica GPS
    // y recibe ofertas desde 2 teléfonos a la vez (dispatch/admin lo veían saltando entre 2 posiciones). El
    // pasajero conserva multi-device (no publica GPS continuo → menos disruptivo); el admin ya es single-session
    // (email-auth). El gate DURO en tiempo real (kickear el socket viejo) lo aplica el gateway `/driver`.
    if (subject === 'driver') {
      await this.sessions.revokeAllForUser(user.id);
    }
    return this.tokenIssuer.issue(user.id, subject, {
      id: user.id,
      phone: user.phone,
      type: user.type,
      kycStatus: user.kycStatus,
    });
  }

  /**
   * Rota el refresh token (reuse detection en el store) y re-emite el access token REPOBLANDO la
   * autorización desde la DB en cada refresh (el refresh NO porta roles/email — solo el `typ` que dice
   * DÓNDE re-leerla). Ramifica por tipo de sujeto:
   *  - `admin` → AdminUser (roles + email repoblados; sin ellos el RolesGuard bloquearía y el watermark
   *    de video perdería la identidad legible del operador, BR-S02).
   *  - passenger/driver → User (roles vacíos por diseño; su autorización vive aguas abajo).
   * El refresh ROTADO se re-firma SIEMPRE con el `typ` resuelto, de modo que un token viejo sin `typ`
   * queda "curado" tras el primer refresh exitoso.
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let claims;
    try {
      claims = await this.jwt.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedError('Refresh token inválido');
    }
    try {
      const { newJti } = await this.sessions.rotate(claims.sid, claims.jti);
      const { accessToken, typ } = await this.reissueAccess(claims.sub, claims.sid, claims.typ);
      // Re-firmamos el refresh CON el `typ` resuelto: el próximo refresh ya no necesita el fallback.
      const newRefresh = await this.jwt.signRefreshToken({
        sub: claims.sub,
        sid: claims.sid,
        jti: newJti,
        typ,
      });
      return { accessToken, refreshToken: newRefresh };
    } catch (err) {
      if (err instanceof RefreshError)
        throw new UnauthorizedError('Sesión revocada o token reutilizado');
      throw err;
    }
  }

  /**
   * Re-emite el access token para el sujeto `sub`, resolviendo la tabla por `typ`:
   *  - `admin` → AdminUser (roles + email REPOBLADOS).
   *  - passenger/driver → User.
   *  - `undefined` (refresh viejo pre-`typ`) → fallback: probamos User primero y, si no existe, AdminUser
   *    (así un admin con token viejo no queda 401 hasta su próximo login). Si ninguno → 401.
   * Devuelve el `typ` resuelto para que el refresh rotado lo lleve.
   */
  private async reissueAccess(
    sub: string,
    sid: string,
    typ: SubjectType | undefined,
  ): Promise<{ accessToken: string; typ: SubjectType }> {
    if (typ === 'admin') {
      return this.reissueAdminAccess(sub, sid);
    }
    if (typ === 'passenger' || typ === 'driver') {
      return this.reissueUserAccess(sub, sid);
    }
    // Backward-compat (refresh sin `typ`): User primero, AdminUser después.
    const user = await this.repo.findUserById(sub);
    if (user && !user.deletedAt) {
      return this.reissueUserAccess(sub, sid);
    }
    return this.reissueAdminAccess(sub, sid);
  }

  private async reissueUserAccess(
    sub: string,
    sid: string,
  ): Promise<{ accessToken: string; typ: SubjectType }> {
    const user = await this.repo.findUserById(sub);
    if (!user || user.deletedAt) throw new UnauthorizedError('Usuario no disponible');
    const resolvedTyp = this.subjectType(user.type);
    const accessToken = await this.jwt.signAccessToken({
      sub: user.id,
      typ: resolvedTyp,
      roles: [],
      sid,
    });
    return { accessToken, typ: resolvedTyp };
  }

  private async reissueAdminAccess(
    sub: string,
    sid: string,
  ): Promise<{ accessToken: string; typ: SubjectType }> {
    const admin = await this.repo.findAdminById(sub);
    if (!admin || admin.deletedAt || !isOperationalAdmin(admin)) {
      throw new UnauthorizedError('Operador no disponible');
    }
    const accessToken = await this.jwt.signAccessToken({
      sub: admin.id,
      typ: 'admin',
      roles: admin.roles as AdminRole[],
      email: admin.email,
      sid,
    });
    return { accessToken, typ: 'admin' };
  }

  /**
   * Revoca la sesión del refresh token. Endpoint COMPARTIDO (passenger/driver/admin).
   * Devuelve `userId` (el `sub` del refresh) SOLO cuando el token era válido, para que el caller que lo
   * necesite (admin-bff: auditoría WORM del logout del operador) pueda armar el actor. El campo es OPCIONAL
   * y ADITIVO: passenger/driver-bff lo ignoran. En el catch (token inválido / logout idempotente) NO hay
   * sesión que auditar → se omite `userId`.
   */
  async logout(refreshToken: string): Promise<{ ok: true; userId?: string }> {
    try {
      const claims = await this.jwt.verifyRefresh(refreshToken);
      await this.sessions.revoke(claims.sid);
      return { ok: true, userId: claims.sub };
    } catch {
      // logout idempotente: token inválido = ya no hay sesión que revocar (ni que auditar)
      return { ok: true };
    }
  }

  /**
   * Cierra la sesión en TODOS los dispositivos (ADR-012 §2). Espejo EXACTO de `logout` salvo el alcance:
   * en vez de `revoke(claims.sid)` (una sesión) llama `revokeAllForUser(claims.sub)`, que borra TODAS las
   * sesiones del user Y sella el denylist epoch `revoked:before:{userId}` → mata al instante los access
   * tokens vivos de todas ellas (no espera a su exp de 15m). Decisión: refreshToken-based como `logout`
   * (poseer un refresh válido = sesión activa = derecho a cerrar todas); NO exige un guard de access token.
   * Devuelve el `userId` (el `sub`) SOLO cuando el token era válido, para que el caller que lo necesite
   * (admin-bff: auditoría WORM) arme el actor. Idempotente: token inválido → { ok: true } sin userId.
   */
  async logoutAll(refreshToken: string): Promise<{ ok: true; userId?: string }> {
    try {
      const claims = await this.jwt.verifyRefresh(refreshToken);
      await this.sessions.revokeAllForUser(claims.sub);
      return { ok: true, userId: claims.sub };
    } catch {
      // logout-all idempotente: token inválido = ya no hay sesiones que revocar (ni que auditar)
      return { ok: true };
    }
  }

  private subjectType(type: UserType): SubjectType {
    return type === 'DRIVER' ? 'driver' : 'passenger';
  }
}
