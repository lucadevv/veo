/**
 * Puerto + adaptador Prisma del share-service (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde del PanicRepository
 * (token DI Symbol + interfaz + adaptador con read/write split + `runInTx`).
 *
 * Las lecturas/escrituras directas son métodos del puerto. Las 3 transacciones del dominio de compartir
 * (createLinkInternal, createPanicFanout, publicView) se abren con `runInTx`: el CUERPO transaccional
 * —create/updateMany del enlace + `enqueueOutbox` en la MISMA tx (FOUNDATION §6)— SIGUE viviendo en el
 * service, que recibe el cliente de transacción. El tx se tipa como `Prisma.TransactionClient` (el real):
 * los cuerpos combinan operaciones sobre `shareLink`/`shareView` con `enqueueOutbox`, que exige el
 * delegate `outboxEvent` real; un puerto estrecho re-implementaría a mano los tipos de Prisma.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type ShareLink, type TripSnapshot, type TrustedContact } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const SHARE_REPO = Symbol('SHARE_REPO');

/** Puerto: el ShareService depende de esto, NO de Prisma. */
export interface ShareRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (create/updateMany
   * del enlace + outbox en la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Lee el snapshot del viaje (read) para validar pertenencia y alimentar la vista pública. `null` si no existe. */
  findTripSnapshotByTripId(tripId: string): Promise<TripSnapshot | null>;
  /** Lee un contacto de confianza por id (read); el service valida que pertenezca al usuario. */
  findContactById(contactId: string): Promise<TrustedContact | null>;
  /** Lee un enlace por su dedupKey (read) para la idempotencia de creación. `null` si no existe. */
  findLinkByDedupKey(dedupKey: string): Promise<ShareLink | null>;
  /** Lee un enlace por id (read). `null` si no existe. */
  findLinkById(shareId: string): Promise<ShareLink | null>;
  /** Lee un enlace por el hash del token (read) para la página pública. `null` si no existe. */
  findLinkByTokenHash(tokenHash: string): Promise<ShareLink | null>;
  /** Revoca un enlace concreto (write). El service ya validó pertenencia y calcula `revokedAt`. */
  revokeLink(shareId: string, revokedAt: Date): Promise<void>;
  /**
   * Kill-switch automático: revoca SOLO los enlaces vivos (`revokedAt: null`) de un viaje (write) y
   * devuelve cuántos se revocaron. Idempotente: un viaje sin enlaces vivos devuelve 0.
   */
  revokeLiveLinksForTrip(tripId: string, revokedAt: Date): Promise<number>;
}

@Injectable()
export class PrismaShareRepository implements ShareRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findTripSnapshotByTripId(tripId: string): Promise<TripSnapshot | null> {
    return this.prisma.read.tripSnapshot.findUnique({ where: { tripId } });
  }

  findContactById(contactId: string): Promise<TrustedContact | null> {
    return this.prisma.read.trustedContact.findUnique({ where: { id: contactId } });
  }

  findLinkByDedupKey(dedupKey: string): Promise<ShareLink | null> {
    return this.prisma.read.shareLink.findUnique({ where: { dedupKey } });
  }

  findLinkById(shareId: string): Promise<ShareLink | null> {
    return this.prisma.read.shareLink.findUnique({ where: { id: shareId } });
  }

  findLinkByTokenHash(tokenHash: string): Promise<ShareLink | null> {
    return this.prisma.read.shareLink.findUnique({ where: { tokenHash } });
  }

  async revokeLink(shareId: string, revokedAt: Date): Promise<void> {
    await this.prisma.write.shareLink.update({ where: { id: shareId }, data: { revokedAt } });
  }

  async revokeLiveLinksForTrip(tripId: string, revokedAt: Date): Promise<number> {
    const result = await this.prisma.write.shareLink.updateMany({
      where: { tripId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }
}
