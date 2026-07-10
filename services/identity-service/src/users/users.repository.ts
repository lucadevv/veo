/**
 * UsersRepository — ÚNICO punto de acceso Prisma del perfil de usuario y el derecho al olvido (schema
 * 'identity'). Espeja el mold de payment/rating: read/write split, OUTBOX-EN-TRANSACCIÓN y métodos con
 * NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo al service.
 *
 * SEAM con UsersService: la LÓGICA DE DOMINIO (merge de campos del perfil, audit de PII enmascarada, ventana
 * de gracia del borrado, tombstone) vive ENTERA en el service. La solicitud de borrado y su evento
 * `user.deletion_requested` van en la MISMA tx (outbox-en-transacción · FOUNDATION §6).
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type User } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type UsersTx = Prisma.TransactionClient;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Usuario por id (perfil + gate de tombstone `deletedAt`). Réplica. */
  findUserById(id: string): Promise<User | null> {
    return this.prisma.read.user.findUnique({ where: { id } });
  }

  /** Update del perfil (merge armado por el service) / cancelación de borrado. Devuelve el user actualizado. */
  updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.write.user.update({ where: { id }, data });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA el gate anti-doble-solicitud + la marca + el evento. */
  runInTransaction<T>(work: (tx: UsersTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: UsersTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /** Usuario por id, DENTRO de la tx (dato fresco para el gate de borrado). */
  findUserByIdTx(tx: UsersTx, id: string): Promise<User | null> {
    return tx.user.findUnique({ where: { id } });
  }

  /** Update del usuario, DENTRO de la tx (marca `deletionRequestedAt`). El service arma la data. */
  async updateUserTx(tx: UsersTx, id: string, data: Prisma.UserUpdateInput): Promise<void> {
    await tx.user.update({ where: { id }, data });
  }
}
