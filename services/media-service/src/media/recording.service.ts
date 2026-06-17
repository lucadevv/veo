/**
 * RecordingService — BR-S01 (cámara/grabación).
 *
 * - Emite tokens LiveKit para la room del viaje (passenger/driver).
 * - Inicia grabación automáticamente al `trip.started` → publica `media.recording_started`.
 * - Finaliza la grabación al `trip.completed` → publica `media.archived`.
 * - EXCEPCIÓN (pánico): al `panic.triggered` fuerza el inicio de grabación aunque el viaje no esté
 *   IN_PROGRESS (force-start) y marca la retención como indefinida.
 *
 * LiveKit y el cálculo de retención van detrás de abstracciones (puerto + función pura).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { LIVEKIT_PORT, type LiveKitPort } from '../ports/livekit/livekit.port';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import { computeRetentionUntil } from './retention';
import type { Env } from '../config/env.schema';

const PRODUCER = 'media-service';

export function roomNameForTrip(tripId: string): string {
  return `trip-${tripId}`;
}

function s3KeyForSegment(tripId: string, segmentId: string): string {
  return `recordings/${tripId}/${segmentId}.mp4`;
}

export interface IssueTokenParams {
  tripId: string;
  identity: string;
  name?: string;
}

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);
  private readonly tokenTtl: number;
  private readonly kmsKeyId: string;
  private readonly defaultDays: number;
  private readonly incidentDays: number;
  private readonly livekitUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LIVEKIT_PORT) private readonly livekit: LiveKitPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    config: ConfigService<Env, true>,
  ) {
    this.tokenTtl = config.getOrThrow<number>('LIVEKIT_TOKEN_TTL_SECONDS');
    this.kmsKeyId = config.getOrThrow<string>('KMS_KEY_ID_VIDEO');
    this.defaultDays = config.getOrThrow<number>('RETENTION_DEFAULT_DAYS');
    this.incidentDays = config.getOrThrow<number>('RETENTION_INCIDENT_DAYS');
    this.livekitUrl = config.getOrThrow<string>('LIVEKIT_URL');
  }

  /** Emite un token LiveKit de cámara para un participante del viaje (BR-S01). */
  async issueRoomToken(
    params: IssueTokenParams,
  ): Promise<{ roomName: string; token: string; url: string; expiresInSeconds: number }> {
    const roomName = roomNameForTrip(params.tripId);
    const token = await this.livekit.issueAccessToken({
      roomName,
      identity: params.identity,
      name: params.name,
      canPublish: true,
      canSubscribe: true,
      ttlSeconds: this.tokenTtl,
    });
    return { roomName, token, url: this.livekitUrl, expiresInSeconds: this.tokenTtl };
  }

  /**
   * Emite un token LiveKit SOLO-SUSCRIPCIÓN (espectador puro) de la cabina EN VIVO de un viaje.
   * Misma room donde PUBLICA el conductor (`roomNameForTrip` = `trip-${tripId}`). Lo usa el muro de
   * cámaras del admin tras doble-auth (Roles + MFA fresca, gateado en el controller). canPublish:false +
   * canPublishData:false → el admin observa, jamás inyecta audio/video/datos en la cabina.
   */
  async issueViewerToken(
    params: IssueTokenParams,
  ): Promise<{ roomName: string; token: string; url: string; expiresInSeconds: number }> {
    const roomName = roomNameForTrip(params.tripId);
    const token = await this.livekit.issueAccessToken({
      roomName,
      identity: params.identity,
      name: params.name,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      ttlSeconds: this.tokenTtl,
    });
    return { roomName, token, url: this.livekitUrl, expiresInSeconds: this.tokenTtl };
  }

  /** Inicio automático de grabación al comenzar el viaje (BR-S01). Idempotente por viaje. */
  async startForTrip(
    tripId: string,
    startedAt: Date,
    opts: { forced?: boolean; panic?: boolean } = {},
  ): Promise<{ segmentId: string; created: boolean }> {
    const open = await this.findOpenSegment(tripId);
    if (open) {
      // Ya hay una grabación en curso para el viaje: no se duplica (idempotencia).
      return { segmentId: open.id, created: false };
    }

    const segmentId = uuidv7();
    const roomName = roomNameForTrip(tripId);
    const s3Key = s3KeyForSegment(tripId, segmentId);
    const { egressId } = await this.livekit.startRecording({ roomName, s3Key });

    const retentionUntil = computeRetentionUntil({
      startedAt,
      hasIncident: false,
      hasPanic: opts.panic ?? false,
      defaultDays: this.defaultDays,
      incidentDays: this.incidentDays,
    });

    await this.prisma.write.$transaction(async (tx) => {
      await tx.mediaSegment.create({
        data: {
          id: segmentId,
          tripId,
          startedAt,
          s3Key,
          codec: 'h264',
          encryptionKeyId: this.kmsKeyId,
          hasPanic: opts.panic ?? false,
          // Pánico ⇒ retención INDEFINIDA (null). Explícito y robusto aunque
          // computeRetentionUntil ya devuelva null con hasPanic:true.
          retentionUntil: opts.panic ? null : retentionUntil,
          egressId,
        },
      });
      const envelope = createEnvelope({
        eventType: 'media.recording_started',
        producer: PRODUCER,
        payload: { tripId, roomName, startedAt: startedAt.toISOString() },
      });
      await enqueueOutbox(tx, envelope, tripId);
    });

    this.logger.log(
      `Grabación iniciada trip=${tripId} segment=${segmentId}${opts.forced ? ' (force-start por pánico)' : ''}`,
    );
    return { segmentId, created: true };
  }

  /** Fin de grabación al completar el viaje (BR-S01) → publica `media.archived`. */
  async finishForTrip(tripId: string, endedAt: Date): Promise<{ archived: boolean }> {
    const open = await this.findOpenSegment(tripId);
    if (!open) return { archived: false };

    let bytes = 0;
    if (open.egressId) {
      const result = await this.livekit.stopRecording(open.egressId);
      bytes = result.bytes;
    }

    const retentionUntil = computeRetentionUntil({
      startedAt: open.startedAt,
      hasIncident: open.hasIncident,
      hasPanic: open.hasPanic,
      defaultDays: this.defaultDays,
      incidentDays: this.incidentDays,
    });
    const retentionDays = retentionDaysFor(open.hasPanic, open.hasIncident, this.defaultDays, this.incidentDays);

    await this.prisma.write.$transaction(async (tx) => {
      await tx.mediaSegment.update({
        where: { id: open.id },
        data: { endedAt, sizeBytes: BigInt(bytes), retentionUntil },
      });
      const envelope = createEnvelope({
        eventType: 'media.archived',
        producer: PRODUCER,
        payload: { tripId, s3Key: open.s3Key, bytes, retentionDays },
      });
      await enqueueOutbox(tx, envelope, tripId);
    });

    this.logger.log(`Grabación archivada trip=${tripId} segment=${open.id} bytes=${bytes}`);
    return { archived: true };
  }

  /**
   * Pánico (BR-S01 excepción): fuerza grabación aunque el viaje no esté IN_PROGRESS y fija la
   * retención del viaje como INDEFINIDA hasta su resolución.
   */
  async onPanic(tripId: string, at: Date): Promise<{ segmentId: string; forced: boolean }> {
    const open = await this.findOpenSegment(tripId);
    if (open) {
      // Ya grababa: solo escalamos la retención a indefinida (pánico).
      await this.prisma.write.mediaSegment.update({
        where: { id: open.id },
        data: { hasPanic: true, retentionUntil: null },
      });
      this.logger.warn(`Pánico trip=${tripId}: retención escalada a indefinida (segment=${open.id})`);
      return { segmentId: open.id, forced: false };
    }

    // Force-start: no había grabación (viaje en ARRIVING u otro estado). El segment se crea YA con
    // los flags de pánico (hasPanic:true, retención indefinida) en una sola escritura atómica: si el
    // proceso crashea, jamás queda evidencia de pánico sin proteger (compliance Ley 29733).
    const started = await this.startForTrip(tripId, at, { forced: true, panic: true });
    return { segmentId: started.segmentId, forced: true };
  }

  /**
   * Derecho al olvido (BR-S06, Ley 29733) · purga del VIDEO DE CABINA de un viaje. La dispara el
   * consumidor de `trip.pii_erased` (dominó de borrado: trip-service anonimiza el viaje del usuario
   * borrado y señala por viaje, porque media-service no puede resolver usuario→viajes sin un join
   * cross-servicio prohibido). Borra los objetos en S3/MinIO (recordings/segmentos) y las filas de
   * `media_segments` del viaje, junto con sus solicitudes de acceso (que referencian el segmento por
   * FK, de otro modo el delete fallaría).
   *
   * Idempotente: si el viaje ya no tiene segmentos (reproceso, o retención ya barrió) es un no-op;
   * `deleteObject` es no-op si el objeto no existe. Devuelve cuántos segmentos se purgaron.
   */
  async eraseTrip(tripId: string): Promise<{ purgedSegments: number }> {
    const segments = await this.prisma.read.mediaSegment.findMany({
      where: { tripId },
      select: { id: true, s3Key: true },
    });
    if (segments.length === 0) return { purgedSegments: 0 };

    // Borra los objetos de almacenamiento primero (idempotente). Si la transacción de DB falla luego,
    // el reproceso vuelve a intentar el borrado de objetos (no-op) y el de filas: sin huérfanos.
    await Promise.all(segments.map((s) => this.storage.deleteObject(s.s3Key)));

    const segmentIds = segments.map((s) => s.id);
    await this.prisma.write.$transaction(async (tx) => {
      // Las solicitudes de acceso referencian el segmento por FK: se borran antes que el segmento.
      await tx.videoAccessRequest.deleteMany({ where: { tripId } });
      await tx.mediaSegment.deleteMany({ where: { id: { in: segmentIds } } });
    });

    this.logger.log(
      `Derecho al olvido: purgado el video del viaje ${tripId} (${segments.length} segmento(s) + objetos S3)`,
    );
    return { purgedSegments: segments.length };
  }

  private async findOpenSegment(tripId: string): Promise<{
    id: string;
    startedAt: Date;
    s3Key: string;
    egressId: string | null;
    hasIncident: boolean;
    hasPanic: boolean;
  } | null> {
    return this.prisma.read.mediaSegment.findFirst({
      where: { tripId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        s3Key: true,
        egressId: true,
        hasIncident: true,
        hasPanic: true,
      },
    });
  }
}

/** Días de retención para el evento `media.archived`. -1 = indefinido (pánico). */
export function retentionDaysFor(
  hasPanic: boolean,
  hasIncident: boolean,
  defaultDays: number,
  incidentDays: number,
): number {
  if (hasPanic) return -1;
  return hasIncident ? incidentDays : defaultDays;
}
