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

  /**
   * Cuentas cuya ventana de gracia de borrado (BR-S06) ya venció y aún no fueron tombstoneadas
   * (`deletedAt null` + `deletionRequestedAt <= cutoff`). Réplica — el barrido diario del DeletionSweeper.
   * Proyección {id, driver:{id}}: resuelve el user y su conductor asociado (si es conductor) para el
   * tombstone atómico. Idempotente por construcción (las ya tombstoneadas quedan fuera del filtro).
   */
  findUsersDueForDeletion(
    cutoff: Date,
  ): Promise<{ id: string; driver: { id: string } | null }[]> {
    return this.prisma.read.user.findMany({
      where: { deletedAt: null, deletionRequestedAt: { lte: cutoff } },
      select: { id: true, driver: { select: { id: true } } },
    });
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

  /** Update del usuario, DENTRO de la tx (marca `deletionRequestedAt` / tombstone). El service arma la data. */
  async updateUserTx(tx: UsersTx, id: string, data: Prisma.UserUpdateInput): Promise<void> {
    await tx.user.update({ where: { id }, data });
  }

  /**
   * Update del conductor asociado, DENTRO de la tx (derecho al olvido · BR-I02: vacía el faceEmbedding de
   * enrolamiento y resetea el binding DNI↔selfie en la MISMA escritura). Parte de la unit-of-work del
   * tombstone del user: por eso vive acá y no dereferencia Prisma fuera del repo. El sweeper arma la data.
   */
  async updateDriverTx(tx: UsersTx, id: string, data: Prisma.DriverUpdateInput): Promise<void> {
    await tx.driver.update({ where: { id }, data });
  }

  /**
   * Anonimiza en batch los intentos de BiometricCheck del usuario, DENTRO de la tx (score/geo/captureRef →
   * neutro), conservando el id por integridad referencial. El sweeper arma la data (tombstone, no hard-delete).
   */
  async anonymizeBiometricChecksTx(
    tx: UsersTx,
    userId: string,
    data: Prisma.BiometricCheckUpdateManyMutationInput,
  ): Promise<void> {
    await tx.biometricCheck.updateMany({ where: { userId }, data });
  }
}
