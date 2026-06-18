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
import { BackgroundCheckStatus, DriverStatus, KycStatus, Prisma } from '../generated/prisma';
import { backgroundCheckMachine, isBackgroundCleared } from '../domain/background-check';
import { driverStatusMachine, type SelfServiceDriverStatus } from '../domain/driver-status';
import { kycStatusMachine } from '../domain/kyc-status';
import type { Env } from '../config/env.schema';

const MAX_BIO_FAILS = 3;
const BIO_LOCK_TTL_SECONDS = 3600; // 1h (BR-I02)
/** TTL del sessionRef de un solo uso minteado por la verificación biométrica (BR-I02). */
const BIO_SESSION_TTL_SECONDS = 120;

/**
 * Estados DESDE los que `to` es alcanzable en el eje DriverStatus (inversa de la tabla de la máquina).
 * Espeja `transitionSources` de trip-service: pensado para el guard CAS atómico
 * (`updateMany({ where: { currentStatus: { in: driverStatusSources(to) } } })`), que mueve el estado en el
 * MISMO statement que valida que era una transición legal — sin check-then-act. Deriva de
 * `driverStatusMachine.transitions` (única fuente de verdad del eje): cero strings mágicos, si la tabla
 * cambia el guard la sigue. Incluye `to` mismo (re-aplicación idempotente: la máquina permite from === to).
 */
function driverStatusSources(to: DriverStatus): DriverStatus[] {
  const transitions = driverStatusMachine.transitions;
  return (Object.keys(transitions) as DriverStatus[]).filter((from) =>
    driverStatusMachine.canTransition(from, to),
  );
}

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

  /**
   * Onboarding del conductor (User type DRIVER): registra su licencia y queda PENDING de aprobación.
   *
   * IDEMPOTENTE Y ORDEN-INDEPENDIENTE (fix P0): el alta del conductor es un wizard multi-paso (datos
   * personales, licencia, biometría) que NO tiene un único "paso creador". Cualquier paso que corra
   * primero debe materializar el agregado Driver; los demás actualizan su slice. Por eso `onboard` hace
   * UPSERT por el unique `userId` (atómico a nivel DB, sin check-then-act ni carrera entre pasos):
   * crea la fila-cascarón con los defaults del agregado + la licencia si aún no existe, o solo actualiza
   * la licencia si ya existía (porque corrió antes `updatePersonalInfo`). Reentrante por diseño: reenviar
   * la licencia NO lanza ConflictError. NO emite evento de dominio (igual que antes): el hecho de negocio
   * "listo para revisión" se representa con backgroundCheckStatus PENDING, que `listPendingApproval`
   * (cola del operador) consulta por estado — no hay consumidor de un "driver.onboarded".
   */
  async onboard(
    userId: string,
    input: { licenseNumber: string; licenseExpiresAt: string },
  ): Promise<{ driverId: string; backgroundCheckStatus: string }> {
    const user = await this.prisma.read.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    if (user.type !== 'DRIVER') throw new ForbiddenError('El usuario no es conductor');

    const licenseExpiresAt = new Date(input.licenseExpiresAt);
    const driver = await this.prisma.write.driver.upsert({
      where: { userId },
      create: {
        userId,
        licenseNumber: input.licenseNumber,
        licenseExpiresAt,
        currentStatus: DriverStatus.OFFLINE,
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
      },
      update: {
        licenseNumber: input.licenseNumber,
        licenseExpiresAt,
      },
    });
    return { driverId: driver.id, backgroundCheckStatus: driver.backgroundCheckStatus };
  }

  listPendingApproval(): Promise<{ id: string; userId: string; licenseNumber: string | null }[]> {
    return this.prisma.read.driver.findMany({
      where: { backgroundCheckStatus: BackgroundCheckStatus.PENDING },
      select: { id: true, userId: true, licenseNumber: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Operador aprueba antecedentes → conductor habilitado (KYC VERIFIED). Emite driver.verified. */
  async approve(driverId: string): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const user = await tx.user.findUnique({ where: { id: driver.userId } });
      if (!user) throw new NotFoundError('Usuario del conductor no encontrado');
      backgroundCheckMachine.assertTransition(
        driver.backgroundCheckStatus,
        BackgroundCheckStatus.CLEARED,
      );
      kycStatusMachine.assertTransition(user.kycStatus, KycStatus.VERIFIED);
      const updated = await tx.driver.update({
        where: { id: driverId },
        data: { backgroundCheckStatus: BackgroundCheckStatus.CLEARED },
      });
      await tx.user.update({
        where: { id: driver.userId },
        data: { kycStatus: KycStatus.VERIFIED },
      });
      const envelope = createEnvelope({
        eventType: 'driver.verified',
        producer: 'identity-service',
        payload: {
          driverId: driver.id,
          userId: driver.userId,
          verifiedAt: new Date().toISOString(),
        },
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

  /**
   * Operador rechaza los antecedentes del conductor (espejo de approve). Persiste el MOTIVO + el
   * momento del rechazo y emite `driver.rejected` por OUTBOX en la MISMA tx (igual que approve emite
   * driver.verified): así nunca hay rechazo sin evento ni evento sin rechazo. El conductor NO queda en
   * dead-end: ve el motivo en la app (GET /drivers/me) y puede corregir-y-reenviar (resubmit).
   * `reason` es opcional: "" si el operador no dio motivo (degradación honesta, nunca un motivo falso).
   */
  async reject(driverId: string, reason: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      // Lecturas DENTRO de la tx de escritura (espeja approve): sin lag de réplica ni TOCTOU
      // con un approve concurrente — el assert se serializa con el write.
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const user = await tx.user.findUnique({ where: { id: driver.userId } });
      if (!user) throw new NotFoundError('Usuario del conductor no encontrado');
      backgroundCheckMachine.assertTransition(
        driver.backgroundCheckStatus,
        BackgroundCheckStatus.REJECTED,
      );
      kycStatusMachine.assertTransition(user.kycStatus, KycStatus.REJECTED);
      const rejectedAt = new Date();
      await tx.driver.update({
        where: { id: driverId },
        data: {
          backgroundCheckStatus: BackgroundCheckStatus.REJECTED,
          rejectionReason: reason,
          rejectedAt,
        },
      });
      await tx.user.update({
        where: { id: driver.userId },
        data: { kycStatus: KycStatus.REJECTED },
      });
      const envelope = createEnvelope({
        eventType: 'driver.rejected',
        producer: 'identity-service',
        payload: {
          driverId: driver.id,
          userId: driver.userId,
          reason,
          rejectedAt: rejectedAt.toISOString(),
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: driver.id,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Suspensión MANUAL del conductor por un operador admin (acción de SAFETY, espejo de reject). Escribe
   * `Driver.suspendedAt` —el MISMO campo que el gate de inicio de turno (startShift) y el eligibility gate
   * de dispatch leen para bloquear (BR-I02)—, así un conductor suspendido NO puede iniciar turno ni aceptar
   * ofertas (enforcement ya existente, fail-closed). Emite `driver.suspended` por OUTBOX en la MISMA tx para
   * que audit/admin-bff reaccionen (igual que reject emite driver.rejected).
   *
   * IDEMPOTENTE por CAS (espeja suspendByFleet): `updateMany({ where: { id, suspendedAt: null } })` solo
   * suspende si NO estaba suspendido; si ya lo estaba, no reescribe el timestamp NI emite un evento duplicado
   * (no-op silencioso, válido por diseño). El `reason` NO se persiste (el modelo Driver no tiene campo de
   * motivo de suspensión, igual que suspendByFleet): viaja al evento + al audit del admin-bff.
   */
  async suspend(driverId: string, reason: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const suspendedAt = new Date();
      // CAS dentro de la tx: si ya estaba suspendido, count=0 → no hay evento (idempotencia extremo-a-extremo).
      const result = await tx.driver.updateMany({
        where: { id: driverId, suspendedAt: null },
        data: { suspendedAt },
      });
      if (result.count === 0) return; // ya suspendido: no-op honesto, sin evento duplicado
      const envelope = createEnvelope({
        eventType: 'driver.suspended',
        producer: 'identity-service',
        payload: {
          driverId: driver.id,
          reason,
          suspendedAt: suspendedAt.toISOString(),
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: driver.id,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Reenvío a revisión del conductor RECHAZADO (resubmit, BR-I01): tras corregir sus datos en la app,
   * el conductor vuelve a la cola de aprobación. Lleva backgroundCheckStatus REJECTED→PENDING y el KYC
   * del usuario REJECTED→PENDING (ambas transiciones se abrieron en las máquinas), y LIMPIA el motivo
   * de rechazo. Idempotencia/seguridad: las máquinas RECHAZAN reenviar desde un estado que no sea
   * REJECTED (p. ej. un conductor ya CLEARED no puede "reenviar"). Sin evento: el conductor vuelve a la
   * cola de pendientes que el operador lista por estado PENDING (no hay consumidor de un "resubmitted").
   */
  async resubmit(userId: string): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { userId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const user = await tx.user.findUnique({ where: { id: driver.userId } });
      if (!user) throw new NotFoundError('Usuario del conductor no encontrado');
      backgroundCheckMachine.assertTransition(
        driver.backgroundCheckStatus,
        BackgroundCheckStatus.PENDING,
      );
      kycStatusMachine.assertTransition(user.kycStatus, KycStatus.PENDING);
      const updated = await tx.driver.update({
        where: { id: driver.id },
        data: {
          backgroundCheckStatus: BackgroundCheckStatus.PENDING,
          rejectionReason: null,
          rejectedAt: null,
        },
      });
      await tx.user.update({
        where: { id: driver.userId },
        data: { kycStatus: KycStatus.PENDING },
      });
      return { id: updated.id, backgroundCheckStatus: updated.backgroundCheckStatus };
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
   *
   * SEPARACIÓN DE RESPONSABILIDADES TRANSACCIONALES (causa raíz de los 3 fixes): el REGISTRO DE AUDITORÍA
   * del intento biométrico y la TRANSICIÓN DE ESTADO del turno son responsabilidades distintas y NO comparten
   * destino transaccional. El biometricCheck (evidencia del intento) se persiste en su PROPIA tx, ANTES de
   * intentar la transición — así un rechazo posterior (suspensión fresca, carrera, transición inválida) NO
   * borra la evidencia con su rollback. La transición a AVAILABLE se hace por CAS atómico: el estado fuente
   * válido Y `suspendedAt: null` viajan en el WHERE del updateMany, así dos startShift concurrentes no pueden
   * ambos ganar (#2 double-shift) y una suspensión recién escrita bloquea sobre el dato FRESCO, no la réplica
   * (#10). count === 0 ⇒ releemos para un error honesto: suspendido (Forbidden) vs. carrera/estado inválido.
   */
  async startShift(
    userId: string,
    input: { sessionRef: string; geoLat?: number; geoLon?: number },
  ): Promise<{ status: 'AVAILABLE'; score: number }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    // Gates baratos de fail-fast sobre la réplica (no autoridad final): el gate de suspensión REAL se
    // re-evalúa sobre el dato fresco dentro del CAS (#10). Aquí solo evita trabajo si ya viene suspendido.
    if (d.suspendedAt) throw new ForbiddenError('Conductor suspendido');
    if (!isBackgroundCleared(d.backgroundCheckStatus)) throw new ForbiddenError('KYC no aprobado');
    if (d.licenseExpiresAt && d.licenseExpiresAt.getTime() < Date.now()) {
      throw new ForbiddenError('Licencia vencida');
    }

    const lockKey = bioLockKey(d.id);
    const fails = Number((await this.redis.get(lockKey)) ?? 0);
    if (fails >= MAX_BIO_FAILS) {
      throw new ForbiddenError('Verificación bloqueada por 1 hora tras 3 intentos fallidos');
    }

    const session = await this.consumeSession(input.sessionRef, userId);
    const passed = session.livenessPassed && session.matchPassed && session.score >= this.minScore;

    const biometricCheckData = {
      userId,
      type: 'SHIFT_START',
      score: session.score,
      passed,
      geoLat: input.geoLat,
      geoLon: input.geoLon,
    } satisfies Prisma.BiometricCheckUncheckedCreateInput;

    if (!passed) {
      // #13 + atomicidad — TX DE EVIDENCIA PROPIA Y SEPARADA: el rechazo biométrico escribe DOS hechos
      // (la auditoría del intento Y el evento de dominio biometric.failed) que pertenecen JUNTOS — o se
      // persiste la evidencia con su evento, o ninguno. Van en UNA tx propia, INDEPENDIENTE de la tx del CAS
      // de transición (#2/#10): el camino fallido ni siquiera llega al CAS, así que esta evidencia nunca queda
      // a merced de un rollback de transición. Antes (post-#13) eran DOS escrituras sueltas sin tx entre sí.
      const envelope = createEnvelope({
        eventType: 'biometric.failed',
        producer: 'identity-service',
        payload: {
          driverId: d.id,
          score: session.score,
          attempt: fails + 1,
          at: new Date().toISOString(),
        },
      });
      await this.prisma.write.$transaction(async (tx) => {
        await tx.biometricCheck.create({ data: biometricCheckData });
        await tx.outboxEvent.create({
          data: {
            aggregateId: d.id,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
      const newFails = await this.redis.incr(lockKey);
      if (newFails === 1) await this.redis.expire(lockKey, BIO_LOCK_TTL_SECONDS);
      throw new UnauthorizedError(
        `Verificación facial fallida (score ${session.score}). Intentos restantes: ${Math.max(0, MAX_BIO_FAILS - newFails)}`,
      );
    }

    // #13 — AUDITORÍA EN SU PROPIA ESCRITURA, ANTES DEL CAS: el registro del intento exitoso PERSISTE sí o sí
    // (evidencia de auditoría), independiente de si la transición de estado posterior pasa o falla. Antes vivía
    // en la MISMA tx que el assert: un assert que fallaba (suspensión/carrera) hacía rollback y se llevaba la
    // evidencia. Es una sola escritura previa e independiente de la tx del CAS — no comparte destino transaccional.
    await this.prisma.write.biometricCheck.create({ data: biometricCheckData });

    // #2 + #10 — TRANSICIÓN POR CAS ATÓMICO: el estado fuente válido (derivado de la máquina, cero strings
    // mágicos) Y `suspendedAt: null` (dato FRESCO, no la réplica) viajan en el WHERE. Dos startShift
    // concurrentes: solo UNO matchea un estado fuente y gana el claim (el otro ve count=0 → carrera).
    await this.prisma.write.$transaction(async (tx) => {
      const claim = await tx.driver.updateMany({
        where: {
          id: d.id,
          suspendedAt: null,
          currentStatus: { in: driverStatusSources(DriverStatus.AVAILABLE) },
        },
        data: { currentStatus: DriverStatus.AVAILABLE, lastVerifiedAt: new Date() },
      });
      if (claim.count === 0) {
        // Releemos para un error HONESTO con el estado real (la auditoría del intento YA quedó persistida).
        const current = await tx.driver.findUnique({
          where: { id: d.id },
          select: { currentStatus: true, suspendedAt: true },
        });
        if (!current) throw new NotFoundError('Conductor no encontrado');
        if (current.suspendedAt) throw new ForbiddenError('Conductor suspendido');
        // No estaba suspendido pero el estado fuente no matcheó: o la máquina rechaza la transición, o
        // otro startShift concurrente ya lo movió (double-shift evitado). assertTransition discrimina:
        // si el estado actual no permite → AVAILABLE lanza InvalidStatusTransition (409); si SÍ permitía
        // pero igual no matcheó, fue una carrera → ConflictError (409).
        driverStatusMachine.assertTransition(current.currentStatus, DriverStatus.AVAILABLE);
        throw new ConflictError('Otro inicio de turno concurrente ganó la transición');
      }
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
    });

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
   *
   * IDEMPOTENTE Y ORDEN-INDEPENDIENTE (fix P0): este suele ser el PRIMER paso del wizard de alta, antes
   * de que exista fila Driver (la licencia llega en `onboard`, paso posterior). UPSERT por el unique
   * `userId` materializa el cascarón con los defaults del agregado + los datos personales si no existe, o
   * solo actualiza el slice personal si ya existe — sin el viejo 404 que bloqueaba el paso 1. Atómico a
   * nivel DB sobre el unique, sin carrera con un `onboard` concurrente.
   */
  async updatePersonalInfo(
    userId: string,
    input: { legalName: string; dni: string; birthDate: string },
  ): Promise<DriverPersonalInfoView> {
    const birthDate = new Date(`${input.birthDate}T00:00:00.000Z`);
    const updated = await this.prisma.write.driver.upsert({
      where: { userId },
      create: {
        userId,
        currentStatus: DriverStatus.OFFLINE,
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
        legalName: input.legalName,
        documentId: input.dni,
        birthDate,
      },
      update: {
        legalName: input.legalName,
        documentId: input.dni,
        birthDate,
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

  /**
   * Cambio de estado de turno autoservicio (fin de turno / pausa). QUÉ estados puede PEDIR el
   * conductor lo restringe el tipo (SelfServiceDriverStatus: solo OFFLINE/ON_BREAK); si la
   * transición desde su estado actual es legítima lo decide la máquina (no hay pausa sin turno).
   * Cualquier vuelta a AVAILABLE (iniciar turno o volver de pausa) NO pasa por aquí: vive en
   * startShift detrás del gate biométrico, y el tipo lo garantiza en compile-time.
   */
  async setStatus(userId: string, status: SelfServiceDriverStatus): Promise<{ status: string }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    driverStatusMachine.assertTransition(d.currentStatus, status);
    const updated = await this.prisma.write.driver.update({
      where: { id: d.id },
      data: { currentStatus: status },
    });
    return { status: updated.currentStatus };
  }
}
