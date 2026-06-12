/**
 * ShareService — creación de enlaces de seguimiento firmados (BR-S05), revocación y la
 * página pública "familia". El token solo se devuelve al crearlo; en la BD vive su hash.
 * La info del viaje proviene del read-model TripSnapshot (alimentado por eventos), nunca de
 * tablas de otros servicios.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { uuidv7, ForbiddenError, NotFoundError, UnprocessableEntityError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { signShareToken, tokenHashOf, verifyShareToken, assertShareLinkUsable } from './share-link';
import type { Env } from '../config/env.schema';

export interface CreatedShareLink {
  shareId: string;
  /** Token opaco (solo se entrega aquí; nunca se vuelve a mostrar). */
  token: string;
  /** URL pública completa lista para enviar al usuario/contacto. */
  url: string;
  tripId: string;
  contactId: string | null;
  expiresAt: string;
  maxUses: number;
  /** true si el enlace ya existía (dedup por dedupKey); en ese caso NO se debe reenviar el SMS. */
  deduped: boolean;
}

export interface FamilyTrackingView {
  shareId: string;
  tripId: string;
  status: string;
  startedAt: string | null;
  driverId: string | null;
  approximateLocation: { lat: number; lon: number; at: string } | null;
  viewedAt: string;
}

export interface CreateLinkOptions {
  contactId?: string;
  ttlSeconds?: number;
  maxUses?: number;
  /** Clave de idempotencia: misma dedupKey reutiliza el enlace existente en vez de crear otro. */
  dedupKey?: string;
}

@Injectable()
export class ShareService {
  private readonly secret: string;
  private readonly defaultTtlSeconds: number;
  private readonly defaultMaxUses: number;
  private readonly publicBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.getOrThrow<string>('SHARE_LINK_SECRET');
    this.defaultTtlSeconds = config.getOrThrow<number>('SHARE_LINK_TTL_SECONDS');
    this.defaultMaxUses = config.getOrThrow<number>('SHARE_LINK_MAX_USES');
    this.publicBaseUrl = config.getOrThrow<string>('SHARE_PUBLIC_BASE_URL').replace(/\/$/, '');
  }

  /**
   * Pertenencia del viaje FALLA-CERRADO (anti-IDOR): solo el pasajero dueño puede gestionar sus
   * enlaces. La fuente es el read-model TripSnapshot (passengerId llega en trip.started y
   * panic.triggered). Sin snapshot, o sin passengerId proyectado, NO podemos verificar al dueño →
   * se deniega con 422 honesto ("aún no disponible"), distinto del 403 por mismatch comprobado.
   * Nunca se asume ownership por ausencia de datos.
   */
  private async assertTripOwnership(userId: string, tripId: string): Promise<void> {
    const snapshot = await this.prisma.read.tripSnapshot.findUnique({ where: { tripId } });
    if (!snapshot?.passengerId) {
      throw new UnprocessableEntityError('El viaje aún no está disponible para compartir', { tripId });
    }
    if (snapshot.passengerId !== userId) {
      throw new ForbiddenError('Solo el pasajero del viaje puede gestionar su enlace de seguimiento');
    }
  }

  /**
   * Crea un enlace de seguimiento para un viaje. Valida (falla-cerrado) que el solicitante sea el
   * pasajero del viaje según el read-model. Devuelve el token (única vez que se expone).
   */
  async createLink(userId: string, tripId: string, opts: CreateLinkOptions = {}): Promise<CreatedShareLink> {
    await this.assertTripOwnership(userId, tripId);
    if (opts.contactId) {
      const contact = await this.prisma.read.trustedContact.findUnique({ where: { id: opts.contactId } });
      if (contact?.userId !== userId) throw new NotFoundError('Contacto no encontrado');
    }
    return this.createLinkInternal(tripId, opts);
  }

  /**
   * Núcleo de creación de enlace (usado por REST y por el flujo de pánico). Inserta el ShareLink y
   * encola share.link_generated en la MISMA transacción (outbox).
   */
  async createLinkInternal(tripId: string, opts: CreateLinkOptions = {}): Promise<CreatedShareLink> {
    // Idempotencia (Kafka at-least-once): si ya existe un enlace con esta dedupKey lo reutilizamos sin
    // crear otro ni reenviar el SMS. El token solo se expone al CREARLO; un dedup no puede reconstruirlo
    // (en BD vive el hash), por eso el retorno deduped no trae token/url usables.
    if (opts.dedupKey) {
      const existing = await this.prisma.read.shareLink.findUnique({ where: { dedupKey: opts.dedupKey } });
      if (existing) return this.toDedupedLink(existing);
    }

    const shareId = uuidv7();
    const ttlSeconds = opts.ttlSeconds ?? this.defaultTtlSeconds;
    const maxUses = opts.maxUses ?? this.defaultMaxUses;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const { token, tokenHash } = signShareToken(shareId, expiresAt.getTime(), this.secret);

    try {
      await this.prisma.write.$transaction(async (tx) => {
        await tx.shareLink.create({
          data: {
            id: shareId,
            tripId,
            contactId: opts.contactId ?? null,
            tokenHash,
            dedupKey: opts.dedupKey ?? null,
            expiresAt,
            maxUses,
          },
        });
        const envelope = createEnvelope({
          eventType: 'share.link_generated',
          producer: 'share-service',
          payload: { shareId, tripId, expiresAt: expiresAt.toISOString() },
        });
        await enqueueOutbox(tx, envelope, shareId);
      });
    } catch (err) {
      // CARRERA: el findUnique de arriba y el create NO son atómicos. Si OTRA réplica del consumer insertó
      // la misma dedupKey en el medio, el constraint @unique hace fallar este create. Re-consultamos: si ahora
      // existe, fue justamente ese dedup (devolvemos el ganador como deduped → no reenvía SMS). Si el fallo NO
      // era por la dedupKey, no hay existente → relanzamos. Mismo patrón que notification.engine (store-agnóstico).
      if (opts.dedupKey) {
        const raced = await this.prisma.read.shareLink.findUnique({ where: { dedupKey: opts.dedupKey } });
        if (raced) return this.toDedupedLink(raced);
      }
      throw err;
    }

    return {
      shareId,
      token,
      url: `${this.publicBaseUrl}/${token}`,
      tripId,
      contactId: opts.contactId ?? null,
      expiresAt: expiresAt.toISOString(),
      maxUses,
      deduped: false,
    };
  }

  /**
   * Pánico (BR-S05, fix de durabilidad): crea EL enlace de seguimiento del viaje y, en la MISMA
   * transacción, encola `panic.fanout_requested` al outbox para que notification-service haga el
   * fan-out DURABLE de SMS (engine con retry/backoff). El SMS YA NO se manda inline desde share.
   *
   * SOBERANÍA (§0.7): el evento lleva SOLO IDs de contacto + el deep-link (URL), CERO teléfonos/nombres;
   * notification los resuelve por gRPC GetTrustedContacts. Idempotencia: dedupKey del enlace por (pánico).
   * En redelivery Kafka el enlace ya existe (deduped) → NO se re-encola el evento (notification tiene su
   * propia idempotencia por contacto). Devuelve `emitted=false` cuando fue dedup (nada nuevo que delegar).
   */
  async createPanicFanout(
    tripId: string,
    input: { panicId: string; passengerId: string; geo: { lat: number; lon: number }; contactIds: string[] },
    opts: { ttlSeconds: number; maxUses: number },
  ): Promise<{ shareId: string; url: string; emitted: boolean }> {
    const dedupKey = `panic:${input.panicId}:link`;

    const existing = await this.prisma.read.shareLink.findUnique({ where: { dedupKey } });
    if (existing) {
      // Redelivery: el enlace (y por ende el evento de fan-out) ya se crearon. No re-delegamos.
      return { shareId: existing.id, url: '', emitted: false };
    }

    const shareId = uuidv7();
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const { token, tokenHash } = signShareToken(shareId, expiresAt.getTime(), this.secret);
    const url = `${this.publicBaseUrl}/${token}`;

    try {
      await this.prisma.write.$transaction(async (tx) => {
        await tx.shareLink.create({
          data: { id: shareId, tripId, contactId: null, tokenHash, dedupKey, expiresAt, maxUses: opts.maxUses },
        });
        // El share.link_generated histórico se mantiene (alimenta read-models/auditoría de enlaces).
        await enqueueOutbox(
          tx,
          createEnvelope({
            eventType: 'share.link_generated',
            producer: 'share-service',
            payload: { shareId, tripId, expiresAt: expiresAt.toISOString() },
          }),
          shareId,
        );
        // Delegación del fan-out durable: SOLO IDs + deep-link (sin PII).
        await enqueueOutbox(
          tx,
          createEnvelope({
            eventType: 'panic.fanout_requested',
            producer: 'share-service',
            dedupKey,
            payload: {
              panicId: input.panicId,
              tripId,
              passengerId: input.passengerId,
              geo: input.geo,
              contactIds: input.contactIds,
              shareLink: url,
            },
          }),
          input.panicId,
        );
      });
    } catch (err) {
      // CARRERA con otra réplica (mismo dedupKey @unique): si ahora existe, la otra réplica ya delegó.
      const raced = await this.prisma.read.shareLink.findUnique({ where: { dedupKey } });
      if (raced) return { shareId: raced.id, url: '', emitted: false };
      throw err;
    }

    return { shareId, url, emitted: true };
  }

  /** Mapea un ShareLink ya existente (dedup) a la forma de retorno SIN token/url (no reconstruibles). */
  private toDedupedLink(link: {
    id: string;
    tripId: string;
    contactId: string | null;
    expiresAt: Date;
    maxUses: number;
  }): CreatedShareLink {
    return {
      shareId: link.id,
      token: '',
      url: '',
      tripId: link.tripId,
      contactId: link.contactId,
      expiresAt: link.expiresAt.toISOString(),
      maxUses: link.maxUses,
      deduped: true,
    };
  }

  /** Revoca un enlace (deja de servir la página pública). Valida pertenencia falla-cerrado vía snapshot. */
  async revoke(userId: string, shareId: string): Promise<{ revokedAt: string }> {
    const link = await this.prisma.read.shareLink.findUnique({ where: { id: shareId } });
    if (!link) throw new NotFoundError('Enlace no encontrado');

    await this.assertTripOwnership(userId, link.tripId);
    if (link.revokedAt) return { revokedAt: link.revokedAt.toISOString() };

    const revokedAt = new Date();
    await this.prisma.write.shareLink.update({ where: { id: shareId }, data: { revokedAt } });
    return { revokedAt: revokedAt.toISOString() };
  }

  /**
   * Página pública (sin login): valida el token (firma + expiración), comprueba el estado autoritativo
   * (revocado/expirado/usos), incrementa usedCount, registra la vista y publica share.viewed (outbox).
   * Devuelve los datos de seguimiento para la "página familia".
   */
  async publicView(token: string, ip: string | null): Promise<FamilyTrackingView> {
    const now = Date.now();
    const claims = verifyShareToken(token, this.secret, now);
    const tokenHash = tokenHashOf(token);

    const link = await this.prisma.read.shareLink.findUnique({ where: { tokenHash } });
    if (link?.id !== claims.shareId) throw new NotFoundError('Enlace no encontrado');

    assertShareLinkUsable(link, now);

    const viewedAt = new Date(now);
    await this.prisma.write.$transaction(async (tx) => {
      // Incremento condicional: si el enlace fue revocado/agotado entre la lectura y aquí, no sirve.
      const updated = await tx.shareLink.updateMany({
        where: { id: link.id, revokedAt: null, usedCount: { lt: link.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (updated.count === 0) throw new ForbiddenError('El enlace de seguimiento ya no está disponible');

      await tx.shareView.create({
        data: { id: uuidv7(), shareId: link.id, ip: ip ?? undefined, viewedAt },
      });
      const envelope = createEnvelope({
        eventType: 'share.viewed',
        producer: 'share-service',
        payload: { shareId: link.id, at: viewedAt.toISOString() },
      });
      await enqueueOutbox(tx, envelope, link.id);
    });

    const snapshot = await this.prisma.read.tripSnapshot.findUnique({ where: { tripId: link.tripId } });
    return {
      shareId: link.id,
      tripId: link.tripId,
      status: snapshot?.status ?? 'UNKNOWN',
      startedAt: snapshot?.startedAt ? snapshot.startedAt.toISOString() : null,
      driverId: snapshot?.driverId ?? null,
      approximateLocation:
        snapshot?.lastLat != null && snapshot?.lastLon != null
          ? {
              lat: snapshot.lastLat,
              lon: snapshot.lastLon,
              at: (snapshot.lastLocationAt ?? snapshot.updatedAt).toISOString(),
            }
          : null,
      viewedAt: viewedAt.toISOString(),
    };
  }
}
