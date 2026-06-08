/**
 * DriversService — onboarding autoservicio + aprobación del operador, y el gate biométrico de turno.
 * BR-I01/I02: sin KYC aprobado no hay turno; liveness+match score >= mínimo; 3 fallos → bloqueo 1h.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createEnvelope } from '@veo/events';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  uuidv7,
} from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricProvider,
} from '../ports/biometric/biometric.port';
import { Prisma } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const MAX_BIO_FAILS = 3;
const BIO_LOCK_TTL_SECONDS = 3600; // 1h (BR-I02)
/** TTL del sessionRef de un solo uso minteado por la verificación biométrica (BR-I02). */
const BIO_SESSION_TTL_SECONDS = 120;

/** Clave Redis del lockout de fallos biométricos del conductor. */
function bioLockKey(driverId: string): string {
  return `veo:bio:fails:${driverId}`;
}

/** Clave Redis del sessionRef de un solo uso (minteado por verify, consumido por startShift). */
function bioSessionKey(sessionRef: string): string {
  return `veo:bio:session:${sessionRef}`;
}

/** Contenido del sessionRef de un solo uso almacenado en Redis. */
interface BiometricSession {
  userId: string;
  kind: 'SHIFT_START';
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
}

/** Resultado de verifyBiometric: el sessionRef minteado + el resultado de la verificación. */
export interface BiometricVerifyMint {
  sessionRef: string;
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
}

/** Datos personales del conductor expuestos por REST (BR-I04). `birthDate` en formato yyyy-mm-dd. */
export interface DriverPersonalInfoView {
  legalName: string | null;
  dni: string | null;
  birthDate: string | null;
}

@Injectable()
export class DriversService {
  private readonly minScore: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BIOMETRIC_PROVIDER) private readonly biometric: BiometricProvider,
    config: ConfigService<Env, true>,
  ) {
    this.minScore = config.getOrThrow<number>('BIOMETRIC_MIN_SCORE');
  }

  /** Onboarding: el conductor (User type DRIVER) registra su licencia → queda PENDING de aprobación. */
  async onboard(
    userId: string,
    input: { licenseNumber: string; licenseExpiresAt: string },
  ): Promise<{ driverId: string; backgroundCheckStatus: string }> {
    const user = await this.prisma.read.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    if (user.type !== 'DRIVER') throw new ForbiddenError('El usuario no es conductor');

    const existing = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (existing) throw new ConflictError('El conductor ya completó el onboarding');

    const driver = await this.prisma.write.driver.create({
      data: {
        userId,
        licenseNumber: input.licenseNumber,
        licenseExpiresAt: new Date(input.licenseExpiresAt),
        currentStatus: 'OFFLINE',
        backgroundCheckStatus: 'PENDING',
      },
    });
    return { driverId: driver.id, backgroundCheckStatus: driver.backgroundCheckStatus };
  }

  listPendingApproval(): Promise<{ id: string; userId: string; licenseNumber: string | null }[]> {
    return this.prisma.read.driver.findMany({
      where: { backgroundCheckStatus: 'PENDING' },
      select: { id: true, userId: true, licenseNumber: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Operador aprueba antecedentes → conductor habilitado (KYC VERIFIED). Emite driver.verified. */
  async approve(driverId: string): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const updated = await tx.driver.update({
        where: { id: driverId },
        data: { backgroundCheckStatus: 'CLEARED' },
      });
      await tx.user.update({ where: { id: driver.userId }, data: { kycStatus: 'VERIFIED' } });
      const envelope = createEnvelope({
        eventType: 'driver.verified',
        producer: 'identity-service',
        payload: { driverId: driver.id, userId: driver.userId, verifiedAt: new Date().toISOString() },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: driver.id,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return { id: updated.id, backgroundCheckStatus: updated.backgroundCheckStatus };
    });
  }

  async reject(driverId: string): Promise<void> {
    const driver = await this.prisma.read.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new NotFoundError('Conductor no encontrado');
    await this.prisma.write.$transaction(async (tx) => {
      await tx.driver.update({ where: { id: driverId }, data: { backgroundCheckStatus: 'REJECTED' } });
      await tx.user.update({ where: { id: driver.userId }, data: { kycStatus: 'REJECTED' } });
    });
  }

  /**
   * Suspende un conductor por orden de fleet-service (documento crítico vencido → `fleet.driver.suspended`).
   * Escribe `Driver.suspendedAt`, que es justamente lo que el gate de inicio de turno (startShift) lee
   * para bloquear (BR-I02). Idempotente: si ya está suspendido no reescribe el timestamp (preserva el
   * momento original de la suspensión) y reentregas del mismo evento no tienen efecto. Si el conductor
   * no existe localmente, se ignora silenciosamente (el evento puede llegar antes que el onboarding).
   *
   * @returns `true` si esta llamada efectivamente suspendió al conductor; `false` si fue no-op.
   */
  async suspendByFleet(driverId: string, suspendedAt: Date): Promise<boolean> {
    const result = await this.prisma.write.driver.updateMany({
      where: { id: driverId, suspendedAt: null },
      data: { suspendedAt },
    });
    return result.count > 0;
  }

  /**
   * Enrolamiento facial mínimo (BR-I02): calcula el embedding de referencia de una foto vía
   * biometric-service y lo guarda en el conductor. Sin enrolamiento no hay verificación en live.
   */
  async enrollFace(
    userId: string,
    input: { photo: string },
  ): Promise<{ enrolled: true; enrolledAt: string }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');

    const embedding = await this.biometric.embed(input.photo);
    if (!embedding.length) {
      throw new ConflictError('No se pudo calcular el embedding facial de referencia');
    }

    const enrolledAt = new Date();
    await this.prisma.write.driver.update({
      where: { id: d.id },
      data: { faceEmbedding: embedding, faceEnrolledAt: enrolledAt },
    });
    return { enrolled: true, enrolledAt: enrolledAt.toISOString() };
  }

  /** Emite un reto de liveness activo para el inicio de turno (BR-I02). */
  async createBiometricChallenge(userId: string): Promise<BiometricChallenge> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    return this.biometric.createChallenge();
  }

  /**
   * Verificación biométrica (BR-I02): corre liveness+match contra el embedding de referencia y
   * MINTEA un sessionRef de un solo uso (TTL 120s) que liga al conductor + 'SHIFT_START' + el
   * resultado. startShift lo consume para aplicar el gate de turno. Si el conductor no está
   * enrolado, se rechaza con 409 claro (no se simula).
   */
  async verifyBiometric(
    userId: string,
    input: { challengeId: string; frames: string[] },
  ): Promise<BiometricVerifyMint> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    if (!d.faceEmbedding || d.faceEmbedding.length === 0) {
      throw new ConflictError('Conductor no enrolado biométricamente');
    }

    const result = await this.biometric.verify({
      driverId: d.id,
      challengeId: input.challengeId,
      frames: input.frames,
      referenceEmbedding: d.faceEmbedding,
    });

    const sessionRef = uuidv7();
    const session: BiometricSession = {
      userId,
      kind: 'SHIFT_START',
      score: Math.round(result.score),
      livenessPassed: result.livenessPassed,
      matchPassed: result.matchPassed,
    };
    await this.redis.set(
      bioSessionKey(sessionRef),
      JSON.stringify(session),
      'EX',
      BIO_SESSION_TTL_SECONDS,
    );
    return {
      sessionRef,
      score: session.score,
      livenessPassed: session.livenessPassed,
      matchPassed: session.matchPassed,
    };
  }

  /**
   * Inicio de turno con gate biométrico (BR-I02). Requiere KYC CLEARED, licencia vigente, no suspendido.
   * Consume el sessionRef de un solo uso minteado por verifyBiometric (lee+borra de Redis) y aplica
   * la lógica de lockout: 3 fallos consecutivos → bloqueo de 1h.
   */
  async startShift(
    userId: string,
    input: { sessionRef: string; geoLat?: number; geoLon?: number },
  ): Promise<{ status: 'AVAILABLE'; score: number }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    if (d.suspendedAt) throw new ForbiddenError('Conductor suspendido');
    if (d.backgroundCheckStatus !== 'CLEARED') throw new ForbiddenError('KYC no aprobado');
    if (d.licenseExpiresAt && d.licenseExpiresAt.getTime() < Date.now()) {
      throw new ForbiddenError('Licencia vencida');
    }

    const lockKey = bioLockKey(d.id);
    const fails = Number((await this.redis.get(lockKey)) ?? 0);
    if (fails >= MAX_BIO_FAILS) {
      throw new ForbiddenError('Verificación bloqueada por 1 hora tras 3 intentos fallidos');
    }

    const session = await this.consumeSession(input.sessionRef, userId);
    const passed =
      session.livenessPassed && session.matchPassed && session.score >= this.minScore;

    await this.prisma.write.$transaction(async (tx) => {
      await tx.biometricCheck.create({
        data: {
          userId,
          type: 'SHIFT_START',
          score: session.score,
          passed,
          geoLat: input.geoLat,
          geoLon: input.geoLon,
        },
      });
      if (passed) {
        await tx.driver.update({
          where: { id: d.id },
          data: { currentStatus: 'AVAILABLE', lastVerifiedAt: new Date() },
        });
        const envelope = createEnvelope({
          eventType: 'driver.verified',
          producer: 'identity-service',
          payload: { driverId: d.id, userId, verifiedAt: new Date().toISOString() },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: d.id,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        const envelope = createEnvelope({
          eventType: 'biometric.failed',
          producer: 'identity-service',
          payload: { driverId: d.id, score: session.score, attempt: fails + 1, at: new Date().toISOString() },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: d.id,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });

    if (!passed) {
      const newFails = await this.redis.incr(lockKey);
      if (newFails === 1) await this.redis.expire(lockKey, BIO_LOCK_TTL_SECONDS);
      throw new UnauthorizedError(
        `Verificación facial fallida (score ${session.score}). Intentos restantes: ${Math.max(0, MAX_BIO_FAILS - newFails)}`,
      );
    }

    await this.redis.del(lockKey);
    return { status: 'AVAILABLE', score: session.score };
  }

  /** Lee+borra (un solo uso) el sessionRef y valida que pertenece al conductor y al kind SHIFT_START. */
  private async consumeSession(sessionRef: string, userId: string): Promise<BiometricSession> {
    const key = bioSessionKey(sessionRef);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new UnauthorizedError('Sesión biométrica inválida o expirada');
    }
    await this.redis.del(key);
    const session = JSON.parse(raw) as BiometricSession;
    if (session.userId !== userId || session.kind !== 'SHIFT_START') {
      throw new UnauthorizedError('La sesión biométrica no corresponde a este conductor');
    }
    return session;
  }

  /**
   * Registra/actualiza los datos personales del conductor autenticado (BR-I04 cumplimiento).
   * `dni` (DNI peruano, 8 dígitos) se valida en el borde; aquí se persiste y se devuelve la vista.
   */
  async updatePersonalInfo(
    userId: string,
    input: { legalName: string; dni: string; birthDate: string },
  ): Promise<DriverPersonalInfoView> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    const updated = await this.prisma.write.driver.update({
      where: { id: d.id },
      data: {
        legalName: input.legalName,
        documentId: input.dni,
        birthDate: new Date(`${input.birthDate}T00:00:00.000Z`),
      },
    });
    return this.toPersonalInfoView(updated);
  }

  private toPersonalInfoView(d: {
    legalName: string | null;
    documentId: string | null;
    birthDate: Date | null;
  }): DriverPersonalInfoView {
    return {
      legalName: d.legalName,
      dni: d.documentId,
      birthDate: d.birthDate ? d.birthDate.toISOString().slice(0, 10) : null,
    };
  }

  async setStatus(userId: string, status: 'OFFLINE' | 'ON_BREAK' | 'AVAILABLE'): Promise<{ status: string }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    const updated = await this.prisma.write.driver.update({
      where: { id: d.id },
      data: { currentStatus: status },
    });
    return { status: updated.currentStatus };
  }
}
