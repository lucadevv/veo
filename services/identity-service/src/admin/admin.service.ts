/**
 * AdminService — operadores del panel: auto-registro (PENDING) → aprobación por ADMIN (ACTIVE + roles),
 * login email+password(argon2id)+TOTP, enrolamiento TOTP, y step-up MFA (BR-S07).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { JwtService, RedisRefreshTokenStore, enrollTotp, verifyTotp } from '@veo/auth';
import { AdminRole as AdminRoles, canGrantRoles, type AdminRole } from '@veo/shared-types';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { AdminStatus } from '../generated/prisma';
import { adminStatusMachine, isOperationalAdmin } from '../domain/admin-status';
import { seal, open } from '../common/secret-box';
import type { Env } from '../config/env.schema';

const VALID_ROLES = new Set(Object.values(AdminRoles));

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; roles: string[] };
}

@Injectable()
export class AdminService {
  private readonly totpEncKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: RedisRefreshTokenStore,
    config: ConfigService<Env, true>,
  ) {
    this.totpEncKey = config.getOrThrow<string>('TOTP_ENC_KEY');
  }

  /** Auto-registro de operador → queda PENDING hasta aprobación. */
  async register(email: string, password: string): Promise<{ id: string; status: string }> {
    const existing = await this.prisma.read.adminUser.findUnique({ where: { email } });
    if (existing) throw new ConflictError('Ya existe un operador con ese email');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const admin = await this.prisma.write.adminUser.create({
      data: { email, passwordHash, roles: [], status: AdminStatus.PENDING },
    });
    return { id: admin.id, status: admin.status };
  }

  /** Un ADMIN/SUPERADMIN aprueba y asigna roles → ACTIVE. */
  async approve(
    actorRoles: AdminRole[],
    adminId: string,
    roles: string[],
  ): Promise<{ id: string; status: string; roles: string[] }> {
    for (const r of roles) {
      if (!VALID_ROLES.has(r as AdminRole)) throw new ValidationError(`Rol inválido: ${r}`);
    }
    // Anti-escalada (autoridad final): el actor solo otorga roles de rango ESTRICTAMENTE menor al
    // suyo (excepción: SUPERADMIN→SUPERADMIN). Corre tras validar el enum y ANTES de tocar la DB.
    // Mensaje honesto sin filtrar rango interno; el detalle estructurado va al log/audit.
    if (!canGrantRoles(actorRoles, roles as AdminRole[])) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles,
        requested: roles,
      });
    }
    const admin = await this.prisma.read.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundError('Operador no encontrado');
    adminStatusMachine.assertTransition(admin.status, AdminStatus.ACTIVE);
    const updated = await this.prisma.write.adminUser.update({
      where: { id: adminId },
      data: { status: AdminStatus.ACTIVE, roles },
    });
    return { id: updated.id, status: updated.status, roles: updated.roles };
  }

  async reject(adminId: string): Promise<void> {
    // Lectura + assert DENTRO de la tx de escritura: sin lag de réplica ni TOCTOU
    // con un approve concurrente.
    await this.prisma.write.$transaction(async (tx) => {
      const admin = await tx.adminUser.findUnique({ where: { id: adminId } });
      if (!admin) throw new NotFoundError('Operador no encontrado');
      adminStatusMachine.assertTransition(admin.status, AdminStatus.REJECTED);
      await tx.adminUser.update({
        where: { id: adminId },
        data: { status: AdminStatus.REJECTED },
      });
    });
  }

  listPending(): Promise<{ id: string; email: string; createdAt: Date }[]> {
    return this.prisma.read.adminUser.findMany({
      where: { status: AdminStatus.PENDING },
      select: { id: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

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
    this.assertTotp(admin.totpSecretEnc, totp);
    return this.issueTokens(admin.id, admin.email, admin.roles);
  }

  /** Confirma el enrolamiento TOTP (primer código válido) y emite tokens. */
  async confirmTotpEnrollment(email: string, password: string, totp: string): Promise<AdminTokens> {
    const admin = await this.requireActiveAndAuthed(email, password);
    if (admin.totpEnrolled) throw new ConflictError('TOTP ya enrolado');
    this.assertTotp(admin.totpSecretEnc, totp);
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
    this.assertTotp(admin.totpSecretEnc, totp);
    const accessToken = await this.jwt.signAccessToken({
      sub: admin.id,
      typ: 'admin',
      roles: admin.roles as AdminRole[],
      sid: 'stepup', // el sid real lo mantiene el refresh; este token solo eleva MFA
      mfaAt: Math.floor(Date.now() / 1000),
    });
    return { accessToken };
  }

  private async requireActiveAndAuthed(email: string, password: string) {
    const admin = await this.prisma.read.adminUser.findUnique({ where: { email } });
    if (!admin) throw new UnauthorizedError('Credenciales inválidas');
    if (!isOperationalAdmin(admin)) {
      throw new ForbiddenError('Operador no activo (pendiente de aprobación)');
    }
    const ok = await argon2.verify(admin.passwordHash, password);
    if (!ok) throw new UnauthorizedError('Credenciales inválidas');
    return admin;
  }

  private assertTotp(totpSecretEnc: string | null, totp: string): void {
    if (!totpSecretEnc) throw new UnauthorizedError('TOTP no configurado');
    if (!verifyTotp(totp, open(totpSecretEnc, this.totpEncKey))) {
      throw new UnauthorizedError('Código TOTP incorrecto');
    }
  }

  private async issueTokens(id: string, email: string, roles: string[]): Promise<AdminTokens> {
    const { sessionId, newJti } = await this.sessions.createSession(id);
    const accessToken = await this.jwt.signAccessToken({
      sub: id,
      typ: 'admin',
      roles: roles as AdminRole[],
      sid: sessionId,
      mfaAt: Math.floor(Date.now() / 1000),
    });
    const refreshToken = await this.jwt.signRefreshToken({ sub: id, sid: sessionId, jti: newJti });
    return { accessToken, refreshToken, admin: { id, email, roles } };
  }
}
