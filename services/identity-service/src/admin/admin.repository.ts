/**
 * AdminRepository — ÚNICO punto de acceso Prisma del agregado AdminUser (operadores del panel, schema
 * 'identity'). Espeja el mold de payment/rating: read/write split, OUTBOX-EN-TRANSACCIÓN (la mutación de
 * privilegio y su evento `admin.role_changed` van en la MISMA tx, Ley 29733 · libro WORM) y métodos con
 * NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo al service.
 *
 * SEAM con AdminService: la LÓGICA DE DOMINIO (anti-escalada de roles, máquina de estados INVITED→ACTIVE/
 * REJECTED, one-shot del token de invitación bajo concurrencia, argon2id, TOTP cifrado AES-256-GCM, lockout
 * anti brute-force) vive ENTERA en el service. Este repo solo hace acceso a datos. Las transiciones que
 * RE-validan el estado dentro de la tx (acceptInvite/reinvite/reject) usan `runInTransaction` + métodos
 * tx-scoped: el service ORQUESTA (lee fresco → assert de máquina → escribe) sin tocar nunca `this.prisma`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { AdminStatus, Prisma, type AdminUser } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type AdminTx = Prisma.TransactionClient;

/** Proyección del listado de operadores (gestión de staff). */
export interface OperatorRow {
  id: string;
  email: string;
  status: AdminStatus;
  roles: string[];
  createdAt: Date;
}

@Injectable()
export class AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ────────────────────────────────────────────────────────────────────────────────

  /** Operador por email (@unique) — pre-check de alta + login/step-up. Réplica. */
  findAdminByEmail(email: string): Promise<AdminUser | null> {
    return this.prisma.read.adminUser.findUnique({ where: { email } });
  }

  /** Operador por id — reinvite/step-up. Réplica. */
  findAdminById(id: string): Promise<AdminUser | null> {
    return this.prisma.read.adminUser.findUnique({ where: { id } });
  }

  /** Invitación VIGENTE por hash de token (one-shot: solo INVITED). Réplica; la garantía dura la da la tx. */
  findInvitedByTokenHash(tokenHash: string): Promise<AdminUser | null> {
    return this.prisma.read.adminUser.findFirst({
      where: { inviteTokenHash: tokenHash, status: AdminStatus.INVITED },
    });
  }

  /** Todos los operadores (gestión de staff), más recientes primero. Réplica. */
  listOperators(): Promise<OperatorRow[]> {
    return this.prisma.read.adminUser.findMany({
      select: { id: true, email: true, status: true, roles: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Escrituras no transaccionales (primary) ───────────────────────────────────────────────────────────

  /** Persiste el secreto TOTP CIFRADO en el primer login sin enrolar (AES-256-GCM · el service sella). */
  async updateAdminById(id: string, data: Prisma.AdminUserUpdateInput): Promise<void> {
    await this.prisma.write.adminUser.update({ where: { id }, data });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA lecturas/escrituras tx-scoped + assert de máquina. */
  runInTransaction<T>(work: (tx: AdminTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (Ley 29733 · WORM). El service arma el envelope. */
  async enqueueOutbox(
    tx: AdminTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /** Crea el operador INVITED (grant inicial de roles), DENTRO de la tx. El service arma la data. */
  createAdmin(tx: AdminTx, data: Prisma.AdminUserCreateInput): Promise<AdminUser> {
    return tx.adminUser.create({ data });
  }

  /** Operador por id, DENTRO de la tx (dato FRESCO para el assert de máquina, sin lag de réplica). */
  findAdminByIdTx(tx: AdminTx, id: string): Promise<AdminUser | null> {
    return tx.adminUser.findUnique({ where: { id } });
  }

  /** Update por id, DENTRO de la tx. El service arma la data (transición de estado / one-shot del token). */
  async updateAdminByIdTx(
    tx: AdminTx,
    id: string,
    data: Prisma.AdminUserUpdateInput,
  ): Promise<void> {
    await tx.adminUser.update({ where: { id }, data });
  }
}
