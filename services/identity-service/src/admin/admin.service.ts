/**
 * AdminService — operadores del panel: onboarding por INVITACIÓN (superadmin crea con roles → INVITED +
 * token de un solo uso; el operador fija su contraseña → ACTIVE), login email+password(argon2id)+TOTP,
 * enrolamiento TOTP, y step-up MFA (BR-S07).
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import argon2 from 'argon2';
import { JwtService, RedisRefreshTokenStore, enrollTotp, verifyTotp } from '@veo/auth';
import { AdminRole as AdminRoles, canGrantRoles, maxRoleRank, type AdminRole } from '@veo/shared-types';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  CLOCK,
  type Clock,
} from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { AdminStatus } from '../generated/prisma';
import { adminStatusMachine, isOperationalAdmin } from '../domain/admin-status';
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TTL_HOURS,
} from '../domain/invite-token';
import { seal, open } from '../common/secret-box';
import { EMAIL_SENDER, type EmailSender } from '../ports/email/email.port';
import type { Env } from '../config/env.schema';

const VALID_ROLES = new Set(Object.values(AdminRoles));

/**
 * Prefijos de claves Redis del lockout de login admin (anti brute-force por email).
 * Namespace propio, SEPARADO de las claves del login de pasajeros (`veo:login-*`): un operador
 * y un pasajero con el mismo correo no comparten contador/lock.
 */
const ADMIN_LOGIN_ATTEMPTS_PREFIX = 'veo:admin-login-attempts:';
const ADMIN_LOGIN_LOCK_PREFIX = 'veo:admin-login-lock:';

/** Mensaje legible de un error desconocido (para logs best-effort). */
function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; roles: string[] };
}

export interface OperatorSummary {
  id: string;
  email: string;
  status: string;
  roles: string[];
  createdAt: Date;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly totpEncKey: string;
  private readonly adminWebUrl: string;
  private readonly loginMaxAttempts: number;
  private readonly loginLockSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: RedisRefreshTokenStore,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.totpEncKey = config.getOrThrow<string>('TOTP_ENC_KEY');
    this.adminWebUrl = config.getOrThrow<string>('ADMIN_WEB_URL');
    this.loginMaxAttempts = config.getOrThrow<number>('LOGIN_MAX_ATTEMPTS');
    this.loginLockSeconds = config.getOrThrow<number>('LOGIN_LOCK_SECONDS');
  }

  /**
   * Un ADMIN/SUPERADMIN crea un operador con sus roles → INVITED + token de invitación de un solo uso.
   * NO se fija contraseña acá: el operador la pone al aceptar la invitación.
   */
  async createOperator(
    actorRoles: AdminRole[],
    email: string,
    roles: AdminRole[],
  ): Promise<{ id: string; inviteToken: string; inviteUrl: string; expiresAt: Date }> {
    for (const r of roles) {
      if (!VALID_ROLES.has(r)) throw new ValidationError(`Rol inválido: ${r}`);
    }
    // Anti-escalada (autoridad final): el actor solo otorga roles de rango ESTRICTAMENTE menor al
    // suyo (excepción: SUPERADMIN→SUPERADMIN). Corre tras validar el enum y ANTES de tocar la DB.
    // Mensaje honesto sin filtrar rango interno; el detalle estructurado va al log/audit.
    if (!canGrantRoles(actorRoles, roles)) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles,
        requested: roles,
      });
    }
    const existing = await this.prisma.read.adminUser.findUnique({ where: { email } });
    if (existing) throw new ConflictError('Ya existe un operador con ese email');

    const { token, tokenHash, expiresAt } = generateInviteToken();
    const admin = await this.prisma.write.adminUser.create({
      data: {
        email,
        roles,
        status: AdminStatus.INVITED,
        passwordHash: null,
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
      },
    });

    const inviteUrl = this.buildInviteUrl(token);
    await this.sendInviteEmail(email, inviteUrl, expiresAt);
    return { id: admin.id, inviteToken: token, inviteUrl, expiresAt };
  }

  /** El operador abre el link de invitación y fija su contraseña → ACTIVE (TOTP queda sin enrolar). */
  async acceptInvite(token: string, password: string): Promise<{ email: string }> {
    const tokenHash = hashInviteToken(token);
    const admin = await this.prisma.read.adminUser.findFirst({
      where: { inviteTokenHash: tokenHash, status: AdminStatus.INVITED },
    });
    if (!admin) throw new UnauthorizedError('Invitación inválida o ya usada');
    if (!admin.inviteExpiresAt || admin.inviteExpiresAt < new Date()) {
      throw new UnauthorizedError('La invitación expiró');
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.prisma.write.$transaction(async (tx) => {
      const fresh = await tx.adminUser.findUnique({ where: { id: admin.id } });
      if (!fresh) throw new UnauthorizedError('Invitación inválida o ya usada');
      // Re-asegura un solo uso bajo concurrencia: si otro accept ya limpió el hash, no hay invitación.
      if (fresh.inviteTokenHash !== tokenHash || fresh.status !== AdminStatus.INVITED) {
        throw new UnauthorizedError('Invitación inválida o ya usada');
      }
      adminStatusMachine.assertTransition(fresh.status, AdminStatus.ACTIVE);
      await tx.adminUser.update({
        where: { id: admin.id },
        // Limpiar el hash invalida el token (un solo uso).
        data: {
          passwordHash,
          status: AdminStatus.ACTIVE,
          inviteTokenHash: null,
          inviteExpiresAt: null,
        },
      });
    });
    return { email: admin.email };
  }

  /** Re-emite la invitación de un operador que aún no la aceptó (regenera token+expiración). */
  async reinvite(
    actorRoles: AdminRole[],
    id: string,
  ): Promise<{ inviteUrl: string; expiresAt: Date }> {
    const admin = await this.prisma.read.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundError('Operador no encontrado');
    if (admin.status !== AdminStatus.INVITED) {
      throw new ConflictError('El operador ya aceptó o no está invitado');
    }
    // Anti-escalada: re-invitar es re-otorgar los mismos roles; el actor debe poder otorgarlos.
    if (!canGrantRoles(actorRoles, admin.roles as AdminRole[])) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles,
        requested: admin.roles,
      });
    }
    const { token, tokenHash, expiresAt } = generateInviteToken();
    await this.prisma.write.adminUser.update({
      where: { id },
      data: { inviteTokenHash: tokenHash, inviteExpiresAt: expiresAt },
    });
    const inviteUrl = this.buildInviteUrl(token);
    await this.sendInviteEmail(admin.email, inviteUrl, expiresAt);
    return { inviteUrl, expiresAt };
  }

  private buildInviteUrl(token: string): string {
    return `${this.adminWebUrl}/accept-invite?token=${token}`;
  }

  /**
   * Degradación honesta: el envío del correo NO debe tumbar la creación de la invitación (el caller
   * recibe el inviteUrl igual y puede compartirlo manualmente). Si SMTP falla, se LOGUEA el warning
   * (no se traga en silencio) y se sigue.
   */
  private async sendInviteEmail(to: string, inviteUrl: string, expiresAt: Date): Promise<void> {
    try {
      await this.email.send({
        to,
        subject: 'Invitación al panel VEO',
        html:
          `<p>Te invitaron a operar el panel de VEO.</p>` +
          `<p>Hacé clic para fijar tu contraseña y activar tu cuenta:</p>` +
          `<p><a href="${inviteUrl}">${inviteUrl}</a></p>` +
          `<p>La invitación vence en ${INVITE_TTL_HOURS} horas ` +
          `(${expiresAt.toISOString()}).</p>`,
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo enviar el correo de invitación a ${to} (la invitación sigue válida): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async reject(actorRoles: AdminRole[], actorId: string, adminId: string): Promise<void> {
    // Lectura + assert DENTRO de la tx de escritura: sin lag de réplica ni TOCTOU
    // con un approve concurrente.
    await this.prisma.write.$transaction(async (tx) => {
      const admin = await tx.adminUser.findUnique({ where: { id: adminId } });
      if (!admin) throw new NotFoundError('Operador no encontrado');
      // Anti-escalada (autoridad final): nadie deshabilita su propia cuenta ni a un operador de rango
      // IGUAL o SUPERIOR. Evita que un ADMIN bloquee a un SUPERADMIN y el lockout entre pares.
      if (actorId === adminId) {
        throw new ForbiddenError('No podés deshabilitar tu propia cuenta');
      }
      if (maxRoleRank(admin.roles as AdminRole[]) >= maxRoleRank(actorRoles)) {
        throw new ForbiddenError(
          'No podés deshabilitar a un operador de rango igual o superior al tuyo',
          { actorRoles, targetRoles: admin.roles },
        );
      }
      adminStatusMachine.assertTransition(admin.status, AdminStatus.REJECTED);
      await tx.adminUser.update({
        where: { id: adminId },
        data: { status: AdminStatus.REJECTED },
      });
    });
  }

  /** Todos los operadores (gestión de staff): id, email, estado, roles, alta. */
  listOperators(): Promise<OperatorSummary[]> {
    return this.prisma.read.adminUser.findMany({
      select: { id: true, email: true, status: true, roles: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // DEUDA: no hay recovery self-service de TOTP admin (un enrolado que pierde su Authenticator solo se recupera con reset manual de totp_enrolled=false en DB) · techo: con 1-2 admins se hace a mano, con más operadores escala mal y tienta a rotar el secreto (lo que desincroniza el teléfono y rompe el login — fue la causa raíz del incidente) · gatillo: si suben los operadores o hay >1 incidente de Authenticator perdido → endpoint de reset de enrolamiento (superadmin resetea a otro operador; jamás rotar el secreto)
  /**
   * Login. Si el operador aún no enroló TOTP, devuelve la URL de enrolamiento (sin tokens).
   * Si ya enroló, exige y verifica el código TOTP, y emite tokens con MFA fresca.
   */
  async login(
    email: string,
    password: string,
    totp?: string,
  ): Promise<AdminTokens | { mustEnrollTotp: true; otpauthUrl: string }> {
    const admin = await this.requireActiveAndAuthed(email, password);

    if (!admin.totpEnrolled) {
      const { secret, otpauthUrl } = enrollTotp(admin.email);
      await this.prisma.write.adminUser.update({
        where: { id: admin.id },
        data: { totpSecretEnc: seal(secret, this.totpEncKey) },
      });
      return { mustEnrollTotp: true, otpauthUrl };
    }

    if (!totp) throw new UnauthorizedError('Se requiere código TOTP');
    // TOTP equivocado tras password correcta también es brute-force (sobre el código de 6 dígitos):
    // registra el fallo bajo la MISMA clave del email para que el lockout lo cubra.
    await this.assertTotp(admin.totpSecretEnc, totp, admin.email);
    return this.issueTokens(admin.id, admin.email, admin.roles);
  }

  /** Confirma el enrolamiento TOTP (primer código válido) y emite tokens. */
  async confirmTotpEnrollment(email: string, password: string, totp: string): Promise<AdminTokens> {
    const admin = await this.requireActiveAndAuthed(email, password);
    if (admin.totpEnrolled) throw new ConflictError('TOTP ya enrolado');
    await this.assertTotp(admin.totpSecretEnc, totp, admin.email);
    await this.prisma.write.adminUser.update({
      where: { id: admin.id },
      data: { totpEnrolled: true },
    });
    return this.issueTokens(admin.id, admin.email, admin.roles);
  }

  /** Step-up: re-verifica TOTP y emite un access token con MFA fresca para acciones sensibles (BR-S07). */
  async stepUp(adminId: string, totp: string): Promise<{ accessToken: string }> {
    const admin = await this.prisma.read.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !isOperationalAdmin(admin)) throw new ForbiddenError('Operador no activo');
    // Lock activo → 429 sin verificar TOTP (corta el brute-force sobre el código en step-up).
    if (await this.isLocked(admin.email)) {
      throw new RateLimitError('Demasiados intentos, esperá unos minutos.');
    }
    await this.assertTotp(admin.totpSecretEnc, totp, admin.email);
    const accessToken = await this.jwt.signAccessToken({
      sub: admin.id,
      typ: 'admin',
      roles: admin.roles as AdminRole[],
      sid: 'stepup', // el sid real lo mantiene el refresh; este token solo eleva MFA
      mfaAt: Math.floor(this.clock.now() / 1000),
      email: admin.email, // operador staff: email legible para watermark/audit (BR-S02)
    });
    return { accessToken };
  }

  /**
   * Verifica que el operador exista, esté operativo y la contraseña sea correcta.
   * Lockout anti brute-force (BR-I06): si el email acumula LOGIN_MAX_ATTEMPTS fallos dentro de la
   * ventana, se bloquea LOGIN_LOCK_SECONDS y devolvemos 429 ANTES de tocar la DB o comparar argon2.
   * Este es el ÚNICO punto de chequeo del lock para password Y TOTP: tanto login() como
   * confirmTotpEnrollment() pasan por acá primero, así que un lock dispara antes de cualquier camino.
   */
  private async requireActiveAndAuthed(email: string, password: string) {
    // Bloqueo activo → 429 sin tocar la DB ni argon2 (corta el brute-force temprano).
    if (await this.isLocked(email)) {
      throw new RateLimitError('Demasiados intentos, esperá unos minutos.');
    }
    const admin = await this.prisma.read.adminUser.findUnique({ where: { email } });
    if (!admin) throw new UnauthorizedError('Credenciales inválidas');
    if (!isOperationalAdmin(admin)) {
      throw new ForbiddenError('Operador no activo (pendiente de aprobación)');
    }
    // ACTIVE siempre tiene passwordHash (lo fija acceptInvite); el guard es por el tipo nullable.
    if (!admin.passwordHash) throw new UnauthorizedError('Credenciales inválidas');
    const ok = await argon2.verify(admin.passwordHash, password);
    if (!ok) {
      await this.registerAdminLoginFailure(email);
      throw new UnauthorizedError('Credenciales inválidas');
    }
    return admin;
  }

  /**
   * Verifica el TOTP. Si falla, registra el fallo bajo la clave del email (mismo contador que el
   * password): un código equivocado tras una password correcta sigue siendo brute-force sobre los
   * 6 dígitos. `email` es opcional para que el caller decida si cuenta el fallo (siempre lo pasa hoy).
   */
  private async assertTotp(totpSecretEnc: string | null, totp: string, email?: string): Promise<void> {
    if (!totpSecretEnc) throw new UnauthorizedError('TOTP no configurado');
    if (!verifyTotp(totp, open(totpSecretEnc, this.totpEncKey), this.clock.now())) {
      if (email) await this.registerAdminLoginFailure(email);
      throw new UnauthorizedError('Código TOTP incorrecto');
    }
  }

  /** Lock activo para ese email. Best-effort: si Redis falla, no bloqueamos (el login sigue). */
  private async isLocked(email: string): Promise<boolean> {
    try {
      return Boolean(await this.redis.get(`${ADMIN_LOGIN_LOCK_PREFIX}${this.lockKeyEmail(email)}`));
    } catch (err) {
      this.logger.warn(`Redis no disponible para chequear el lock de login admin: ${asMessage(err)}`);
      return false;
    }
  }

  /**
   * Registra un fallo de login (password o TOTP): INCR del contador (EXPIRE de ventana en el primer
   * fallo) y, si alcanza el tope, setea el lock con EX. Best-effort: si Redis falla, no rompe el 401.
   */
  private async registerAdminLoginFailure(email: string): Promise<void> {
    const key = this.lockKeyEmail(email);
    try {
      const attemptsKey = `${ADMIN_LOGIN_ATTEMPTS_PREFIX}${key}`;
      const attempts = await this.redis.incr(attemptsKey);
      if (attempts === 1) {
        await this.redis.expire(attemptsKey, this.loginLockSeconds);
      }
      if (attempts >= this.loginMaxAttempts) {
        await this.redis.set(`${ADMIN_LOGIN_LOCK_PREFIX}${key}`, '1', 'EX', this.loginLockSeconds);
      }
    } catch (err) {
      this.logger.warn(`Redis no disponible para registrar fallo de login admin: ${asMessage(err)}`);
    }
  }

  /** Limpia contador + lock tras un login exitoso. Best-effort. */
  private async clearAdminLoginFailures(email: string): Promise<void> {
    const key = this.lockKeyEmail(email);
    try {
      await this.redis.del(
        `${ADMIN_LOGIN_ATTEMPTS_PREFIX}${key}`,
        `${ADMIN_LOGIN_LOCK_PREFIX}${key}`,
      );
    } catch (err) {
      this.logger.warn(`Redis no disponible para limpiar el lockout de login admin: ${asMessage(err)}`);
    }
  }

  /** Normaliza el email para la clave del lockout (mismo criterio que el login de pasajeros). */
  private lockKeyEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private async issueTokens(id: string, email: string, roles: string[]): Promise<AdminTokens> {
    // Éxito completo (tokens emitidos): limpiamos contador + lock del email.
    await this.clearAdminLoginFailures(email);
    const { sessionId, newJti } = await this.sessions.createSession(id);
    const accessToken = await this.jwt.signAccessToken({
      sub: id,
      typ: 'admin',
      roles: roles as AdminRole[],
      sid: sessionId,
      mfaAt: Math.floor(this.clock.now() / 1000),
      email, // operador staff: email legible para watermark/audit (BR-S02)
    });
    const refreshToken = await this.jwt.signRefreshToken({
      sub: id,
      sid: sessionId,
      jti: newJti,
      typ: 'admin',
    });
    return { accessToken, refreshToken, admin: { id, email, roles } };
  }
}
