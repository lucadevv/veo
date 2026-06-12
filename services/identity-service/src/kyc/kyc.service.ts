/**
 * KycService — verificación de identidad del PASAJERO (decisión de producto: liveness OK → VERIFIED).
 * A diferencia del conductor, el pasajero NO requiere antecedentes manuales: pasar liveness basta.
 * Patrón gemelo a DriversService (enroll + verify biométrico), pero self-match en una sola pasada.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { ConflictError, ForbiddenError, NotFoundError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricProvider,
} from '../ports/biometric/biometric.port';
import { KycStatus, Prisma } from '../generated/prisma';
import { kycStatusMachine } from '../domain/kyc-status';
import type { Env } from '../config/env.schema';

/** Entrada de la verificación KYC del pasajero: reto + frames del reto en base64 plano. */
export interface KycVerifyInput {
  challengeId: string;
  frames: string[];
}

/** Resultado externo de la verificación KYC (lo reexpone el public-bff a la app). */
export interface KycVerifyResult {
  status: 'VERIFIED' | 'REJECTED';
  verificationId: string;
  reason?: string;
}

@Injectable()
export class KycService {
  private readonly minScore: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BIOMETRIC_PROVIDER) private readonly biometric: BiometricProvider,
    config: ConfigService<Env, true>,
  ) {
    this.minScore = config.getOrThrow<number>('BIOMETRIC_MIN_SCORE');
  }

  /** Carga el pasajero (User type PASSENGER) o lanza el error adecuado. */
  private async loadPassenger(userId: string): Promise<{ id: string; kycStatus: KycStatus }> {
    const user = await this.prisma.read.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    if (user.type !== 'PASSENGER') throw new ForbiddenError('El usuario no es pasajero');
    return { id: user.id, kycStatus: user.kycStatus };
  }

  /** Emite un reto de liveness activo para el KYC del pasajero. */
  async createChallenge(userId: string): Promise<BiometricChallenge> {
    await this.loadPassenger(userId);
    return this.biometric.createChallenge();
  }

  /**
   * Verifica el liveness del pasajero. El mejor frame (el primero) se usa como foto de referencia
   * para calcular el embedding; luego se corre verify contra ese mismo embedding (self-match en una
   * sola pasada: el pasajero no tiene enrolamiento previo). Por eso NO exigimos matchPassed —
   * el match es trivialmente self vs self; lo determinante es livenessPassed + score >= mínimo.
   * Si pasa → kycStatus VERIFIED + outbox user.kyc_verified. Si no → queda PENDING (sin evento).
   */
  async verify(userId: string, input: KycVerifyInput): Promise<KycVerifyResult> {
    const passenger = await this.loadPassenger(userId);

    const bestFrame = input.frames[0];
    if (!bestFrame) throw new ConflictError('No se recibió ningún frame para la verificación');

    const embedding = await this.biometric.embed(bestFrame);
    if (!embedding.length) {
      throw new ConflictError('No se pudo calcular el embedding facial del pasajero');
    }

    const result = await this.biometric.verify({
      // El campo se llama driverId en el puerto, pero es el subjectId genérico: aquí el pasajero.
      driverId: passenger.id,
      challengeId: input.challengeId,
      frames: input.frames,
      referenceEmbedding: embedding,
    });

    // Decisión: liveness + score son suficientes. NO exigimos matchPassed (enrolamiento + self-match).
    const passed = result.livenessPassed && result.score >= this.minScore;
    const verificationId = uuidv7();

    if (passed) {
      // Cubre la re-verificación idempotente (VERIFIED → VERIFIED) y falla cerrado ante un
      // kycStatus legacy fuera del enum; PENDING nunca se "des-decide" (lo garantiza la tabla).
      kycStatusMachine.assertTransition(passenger.kycStatus, KycStatus.VERIFIED);
      const verifiedAt = new Date();
      await this.prisma.write.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: passenger.id },
          data: {
            kycStatus: KycStatus.VERIFIED,
            faceEmbedding: embedding,
            kycVerifiedAt: verifiedAt,
          },
        });
        const envelope = createEnvelope({
          eventType: 'user.kyc_verified',
          producer: 'identity-service',
          payload: {
            userId: passenger.id,
            kycStatus: KycStatus.VERIFIED,
            verifiedAt: verifiedAt.toISOString(),
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: passenger.id,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return { status: KycStatus.VERIFIED, verificationId };
    }

    // Fallo de liveness: no cambiamos kycStatus (queda PENDING) ni emitimos verified.
    return { status: KycStatus.REJECTED, verificationId, reason: 'liveness_failed' };
  }
}
