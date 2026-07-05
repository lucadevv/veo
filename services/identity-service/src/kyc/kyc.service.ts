/**
 * KycService — verificación de identidad del PASAJERO (decisión de producto: liveness OK → VERIFIED).
 * A diferencia del conductor, el pasajero NO requiere antecedentes manuales: pasar liveness basta.
 * Patrón gemelo a DriversService (enroll + verify biométrico), pero self-match en una sola pasada.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { ConflictError, ForbiddenError, NotFoundError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricProvider,
} from '../ports/biometric/biometric.port';
import { KycStatus } from '../generated/prisma';
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
   * Si pasa → kycStatus VERIFIED + outbox user.kyc_verified. Si no → NO se persiste nada: el kycStatus
   * queda en su estado actual (típicamente UNVERIFIED, el estado inicial post ADR-018) y se devuelve
   * REJECTED al caller sin escribir DB. El liveness del pasajero es OPCIONAL (badge de confianza), no
   * un muro pre-viaje (ADR-018): un fallo no bloquea pedir.
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
      // Valida la transición contra la máquina de estados: UNVERIFIED/PENDING/REJECTED/EXPIRED → VERIFIED
      // es legal (cubre la re-verificación tras un rechazo o caducidad); falla cerrado ante un kycStatus
      // legacy fuera del enum. Una verificación VIGENTE no se "des-decide" sola (lo garantiza la tabla).
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
        await enqueueOutbox(
          tx,
          createEnvelope({
            eventType: 'user.kyc_verified',
            producer: 'identity-service',
            payload: {
              userId: passenger.id,
              kycStatus: KycStatus.VERIFIED,
              verifiedAt: verifiedAt.toISOString(),
            },
          }),
          passenger.id,
        );
      });
      return { status: KycStatus.VERIFIED, verificationId };
    }

    // Fallo de liveness: NO persistimos nada (el kycStatus queda en su estado actual, típicamente
    // UNVERIFIED) ni emitimos verified. Devolvemos REJECTED al caller como resultado del intento; el
    // pasajero puede reintentar cuando quiera (el liveness es opcional, no gatea pedir — ADR-018).
    return { status: KycStatus.REJECTED, verificationId, reason: 'liveness_failed' };
  }
}
