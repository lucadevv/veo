/**
 * EmailAuthService — método correo+contraseña SOBERANO (ADR-012 §4, Lote 2).
 * register → verify-email → login + forgot/reset. Hash argon2id (patrón AdminUser), códigos
 * efímeros en Redis (EmailCodeService), correo por el puerto EMAIL_SENDER (SMTP propio / sandbox).
 *
 * Flujo feliz: register(envía código, NO emite tokens) → verify(emite JWT) → login(emite JWT).
 * Caminos infelices (§5): duplicado verificado → 409; sin verificar → reenvía; login sin verificar → 403;
 * password mala → 401 genérico; forgot SIEMPRE {sent:true} (anti-enumeración); reset revoca sesiones.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { RedisRefreshTokenStore, type SubjectType } from '@veo/auth';
import { createEnvelope } from '@veo/events';
import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '@veo/utils';
import argon2 from 'argon2';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { EmailCodeService } from './email-code.service';
import { TokenIssuerService } from './token-issuer.service';
import { resolveUserForVerifiedEmail } from './account-linking';
import { registerUser } from './user-registration';
import { EMAIL_SENDER, type EmailSender } from '../ports/email/email.port';
import { Prisma, type UserType } from '../generated/prisma';
import type { Env } from '../config/env.schema';
import type { AuthTokens } from './dto/auth.dto';

/** Prefijo de claves Redis del lockout de login (anti brute-force por email). */
const LOGIN_ATTEMPTS_PREFIX = 'veo:login-attempts:';
const LOGIN_LOCK_PREFIX = 'veo:login-lock:';

const PASSWORD_MIN_LENGTH = 12;
/** Contraseñas obviamente triviales rechazadas aunque cumplan la longitud mínima. */
const TRIVIAL_PASSWORDS = new Set([
  'password1234',
  'contrasena12',
  '123456789012',
  'qwertyuiopas',
  'aaaaaaaaaaaa',
]);

@Injectable()
export class EmailAuthService {
  private readonly loginMaxAttempts: number;
  private readonly loginLockSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RedisRefreshTokenStore,
    private readonly codes: EmailCodeService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tokenIssuer: TokenIssuerService,
    config: ConfigService<Env, true>,
  ) {
    this.loginMaxAttempts = config.getOrThrow<number>('LOGIN_MAX_ATTEMPTS');
    this.loginLockSeconds = config.getOrThrow<number>('LOGIN_LOCK_SECONDS');
  }

  /**
   * Registro por correo. Si el correo es nuevo → crea User + AuthMethod{EMAIL_PASSWORD} (sin verificar)
   * + outbox user.registered, todo en una tx. Si ya existe SIN verificar → reenvía el código (no error).
   * Si ya existe VERIFICADO → 409. NO emite tokens: primero hay que verificar el correo.
   */
  async register(
    rawEmail: string,
    password: string,
    name: string | undefined,
    type: UserType,
  ): Promise<{ sent: true }> {
    const email = this.normalizeEmail(rawEmail);
    this.assertStrongPassword(password);

    const existing = await this.prisma.read.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
    });

    if (existing?.emailVerified) {
      throw new ConflictError('Ese correo ya está registrado, iniciá sesión.');
    }

    if (existing) {
      // Existe sin verificar: re-emitir código (no duplicar la credencial). Cooldown aplica.
      await this.sendVerificationCode(email);
      return { sent: true };
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    await this.prisma.write.$transaction(async (tx) => {
      // Re-chequeo dentro de la tx (anti-carrera): si otro registro ganó, no duplicamos.
      const dup = await tx.authMethod.findUnique({
        where: { type_email: { type: 'EMAIL_PASSWORD', email } },
      });
      if (dup) return;

      // Account-linking: si ese correo YA pertenece a un User vía otro método verificado
      // (ej. Google, Lote 3), colgamos la credencial EMAIL_PASSWORD de ESE User en vez de
      // crear uno nuevo. Si no hay vínculo previo → User nuevo (caso normal de hoy).
      const linkedUserId = await resolveUserForVerifiedEmail(tx, email);

      // Sin vínculo previo → User nuevo + outbox user.registered (caso normal de hoy).
      // Con vínculo → solo colgamos la credencial EMAIL_PASSWORD del User existente (sin outbox).
      if (linkedUserId) {
        await tx.authMethod.create({
          data: {
            userId: linkedUserId,
            type: 'EMAIL_PASSWORD',
            email,
            passwordHash,
            emailVerified: false,
            verified: false,
          },
        });
        return;
      }

      // Alta nueva: User + credencial EMAIL_PASSWORD + outbox user.registered, vía el registro
      // transaccional único (Lote A2).
      await registerUser(tx, {
        user: { email, name, type },
        authMethod: {
          type: 'EMAIL_PASSWORD',
          email,
          passwordHash,
          emailVerified: false,
          verified: false,
        },
      });
    });

    await this.sendVerificationCode(email);
    return { sent: true };
  }

  /**
   * Reenvía el código de verificación de correo (endpoint dedicado; reemplaza el HACK de re-llamar
   * register con una contraseña placeholder). Solo re-emite si EXISTE un AuthMethod{EMAIL_PASSWORD}
   * SIN verificar. Si no existe o YA está verificado → devuelve {sent:true} igual (anti-enumeración):
   * no se revela el estado de la cuenta. El cooldown lo aplica EmailCodeService igual que register
   * (RateLimitError si se pide demasiado pronto); reutiliza la MISMA lógica de envío (sendVerificationCode).
   */
  async resendVerification(rawEmail: string): Promise<{ sent: true }> {
    const email = this.normalizeEmail(rawEmail);
    const method = await this.prisma.read.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
    });

    // Solo reenvía a una cuenta existente y SIN verificar. En cualquier otro caso, respuesta uniforme.
    if (method && !method.emailVerified) {
      await this.sendVerificationCode(email);
    }
    return { sent: true };
  }

  /**
   * Verifica el correo con el código emailado → marca emailVerified+verified → emite JWT.
   * Camino feliz tras register.
   */
  async verifyEmail(rawEmail: string, code: string): Promise<AuthTokens> {
    const email = this.normalizeEmail(rawEmail);
    await this.codes.verify('email-verify', email, code);

    const method = await this.prisma.write.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
      include: { user: true },
    });
    if (!method) throw new UnauthorizedError('Método de correo no encontrado.');

    // Marca emailVerified + emite outbox user.email_verified en la MISMA tx (mismo patrón que register
    // con user.registered): o se confirma el correo y se publica el evento, o nada (atomicidad outbox).
    await this.prisma.write.$transaction(async (tx) => {
      await tx.authMethod.update({
        where: { id: method.id },
        data: { emailVerified: true, verified: true },
      });
      const envelope = createEnvelope({
        eventType: 'user.email_verified',
        producer: 'identity-service',
        payload: {
          userId: method.user.id,
          email,
          verifiedAt: new Date().toISOString(),
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: method.user.id,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return this.tokenIssuer.issue(method.user.id, this.subjectType(method.user.type), {
      id: method.user.id,
      phone: method.user.phone,
      type: method.user.type,
      kycStatus: method.user.kycStatus,
      email,
    });
  }

  /**
   * Login por correo+contraseña. 401 genérico si no existe el método o el password falla
   * (no se revela cuál); 403 si el correo no está verificado.
   * Lockout anti brute-force (BR-I06): si el email acumula LOGIN_MAX_ATTEMPTS fallos dentro de la
   * ventana, se bloquea LOGIN_LOCK_SECONDS y devolvemos 429 ANTES de comparar la contraseña.
   */
  async login(rawEmail: string, password: string): Promise<AuthTokens> {
    const email = this.normalizeEmail(rawEmail);

    // Bloqueo activo → 429 sin tocar la DB ni argon2 (corta el brute-force temprano).
    if (await this.redis.get(`${LOGIN_LOCK_PREFIX}${email}`)) {
      throw new RateLimitError('Demasiados intentos, esperá unos minutos.');
    }

    const method = await this.prisma.read.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
      include: { user: true },
    });

    if (!method?.passwordHash) {
      throw new UnauthorizedError('Correo o contraseña incorrectos.');
    }
    if (!method.emailVerified) {
      throw new ForbiddenError('Verificá tu correo antes de iniciar sesión.');
    }
    const ok = await argon2.verify(method.passwordHash, password);
    if (!ok) {
      await this.registerLoginFailure(email);
      throw new UnauthorizedError('Correo o contraseña incorrectos.');
    }

    // Éxito: limpiamos contador + lock.
    await this.redis.del(`${LOGIN_ATTEMPTS_PREFIX}${email}`, `${LOGIN_LOCK_PREFIX}${email}`);

    return this.tokenIssuer.issue(method.user.id, this.subjectType(method.user.type), {
      id: method.user.id,
      phone: method.user.phone,
      type: method.user.type,
      kycStatus: method.user.kycStatus,
      email,
    });
  }

  /**
   * Registra un fallo de password: INCR del contador (EXPIRE de ventana en el primer fallo) y,
   * si alcanza el tope, setea el lock con EX. Best-effort: si Redis falla, el login sigue su 401.
   */
  private async registerLoginFailure(email: string): Promise<void> {
    const attemptsKey = `${LOGIN_ATTEMPTS_PREFIX}${email}`;
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) {
      await this.redis.expire(attemptsKey, this.loginLockSeconds);
    }
    if (attempts >= this.loginMaxAttempts) {
      await this.redis.set(`${LOGIN_LOCK_PREFIX}${email}`, '1', 'EX', this.loginLockSeconds);
    }
  }

  /**
   * Olvidé mi contraseña. Anti-enumeración (§5): SIEMPRE devuelve {sent:true}, exista o no el correo.
   * Solo emite el código de reset si el método existe; el resto de operaciones/timing es uniforme.
   */
  async forgotPassword(rawEmail: string): Promise<{ sent: true }> {
    const email = this.normalizeEmail(rawEmail);
    const method = await this.prisma.read.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
    });

    if (method) {
      // silent: si hay cooldown, no lanzamos (mantiene la respuesta uniforme).
      const code = await this.codes.issue('pwd-reset', email, { silent: true });
      if (code) {
        await this.email.send({
          to: email,
          subject: 'Restablecé tu contraseña VEO',
          html: this.resetEmailHtml(code),
        });
      }
    }
    return { sent: true };
  }

  /**
   * Reset de contraseña con código de un solo uso (§5). Tras cambiar la contraseña, revoca TODAS
   * las sesiones del usuario (anti-takeover).
   */
  async resetPassword(rawEmail: string, code: string, newPassword: string): Promise<{ ok: true }> {
    const email = this.normalizeEmail(rawEmail);
    this.assertStrongPassword(newPassword);
    await this.codes.verify('pwd-reset', email, code);

    const method = await this.prisma.write.authMethod.findUnique({
      where: { type_email: { type: 'EMAIL_PASSWORD', email } },
    });
    if (!method) throw new UnauthorizedError('Método de correo no encontrado.');

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.write.authMethod.update({
      where: { id: method.id },
      data: { passwordHash },
    });

    await this.sessions.revokeAllForUser(method.userId);
    return { ok: true };
  }

  // ── helpers ──

  private async sendVerificationCode(email: string): Promise<void> {
    const code = await this.codes.issue('email-verify', email);
    if (!code) return; // cooldown vigente: no reenviamos todavía.
    await this.email.send({
      to: email,
      subject: 'Verificá tu correo VEO',
      html: this.verifyEmailHtml(code),
    });
  }

  private normalizeEmail(raw: string): string {
    const email = raw.trim().toLowerCase();
    // Validación de formato de respaldo (el DTO ya valida en el borde con @IsEmail).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError('Correo inválido');
    }
    return email;
  }

  private assertStrongPassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new ValidationError('La contraseña debe tener al menos 12 caracteres');
    }
    if (TRIVIAL_PASSWORDS.has(password.toLowerCase())) {
      throw new ValidationError('La contraseña es demasiado común. Elegí una más segura.');
    }
  }

  private verifyEmailHtml(code: string): string {
    return `<p>Tu código de verificación VEO es <strong>${code}</strong>. Válido 10 minutos. No lo compartas.</p>`;
  }

  private resetEmailHtml(code: string): string {
    return `<p>Tu código para restablecer la contraseña VEO es <strong>${code}</strong>. Válido 1 hora. Si no lo pediste, ignorá este correo.</p>`;
  }

  private subjectType(type: UserType): SubjectType {
    return type === 'DRIVER' ? 'driver' : 'passenger';
  }
}
