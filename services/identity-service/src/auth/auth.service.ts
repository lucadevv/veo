/**
 * AuthService — login con teléfono + OTP (pasajero/conductor), emisión de JWT ES256,
 * rotación de refresh (Redis) y logout. Crea el User en su primer login y emite user.registered.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  JwtService,
  RedisRefreshTokenStore,
  RefreshError,
  type SubjectType,
} from '@veo/auth';
import { parseOrThrow, peruPhoneSchema, UnauthorizedError } from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { OtpService } from './otp.service';
import { TokenIssuerService } from './token-issuer.service';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import { Prisma, type UserType } from '../generated/prisma';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
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

    const user = await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { phone } });
      if (existing) {
        // Asegurar el AuthMethod{PHONE_OTP} de usuarios previos (idempotente, ADR-012 Lote 1).
        await tx.authMethod.upsert({
          where: { userId_type: { userId: existing.id, type: 'PHONE_OTP' } },
          create: { userId: existing.id, type: 'PHONE_OTP', verified: true },
          update: {},
        });
        return existing;
      }
      const created = await tx.user.create({ data: { phone, type } });
      // Credencial del método teléfono+OTP (ADR-012 §2): cuelga del mismo User.
      await tx.authMethod.create({
        data: { userId: created.id, type: 'PHONE_OTP', verified: true },
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
    });
  }

  /** Rota el refresh token (reuse detection en el store). */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let claims;
    try {
      claims = await this.jwt.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedError('Refresh token inválido');
    }
    try {
      const { newJti } = await this.sessions.rotate(claims.sid, claims.jti);
      const user = await this.prisma.read.user.findUnique({ where: { id: claims.sub } });
      if (!user || user.deletedAt) throw new UnauthorizedError('Usuario no disponible');
      const accessToken = await this.jwt.signAccessToken({
        sub: user.id,
        typ: this.subjectType(user.type),
        roles: [],
        sid: claims.sid,
      });
      const newRefresh = await this.jwt.signRefreshToken({ sub: user.id, sid: claims.sid, jti: newJti });
      return { accessToken, refreshToken: newRefresh };
    } catch (err) {
      if (err instanceof RefreshError) throw new UnauthorizedError('Sesión revocada o token reutilizado');
      throw err;
    }
  }

  async logout(refreshToken: string): Promise<{ ok: true }> {
    try {
      const claims = await this.jwt.verifyRefresh(refreshToken);
      await this.sessions.revoke(claims.sid);
    } catch {
      // logout idempotente: token inválido = ya no hay sesión que revocar
    }
    return { ok: true };
  }

  private subjectType(type: UserType): SubjectType {
    return type === 'DRIVER' ? 'driver' : 'passenger';
  }
}
