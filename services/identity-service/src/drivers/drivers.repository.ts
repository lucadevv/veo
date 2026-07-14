/**
 * DriversRepository — ÚNICO punto de acceso Prisma del agregado Driver (schema 'identity'). Espeja el patrón
 * de `payouts.repository.ts`/`ratings.repository.ts`: encapsula el read/write split (réplica vs primary), el
 * patrón OUTBOX-EN-TRANSACCIÓN (la mutación de dominio y el INSERT de su evento van en la MISMA tx Prisma,
 * FOUNDATION §6) y expone métodos con NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con DriversService: la LÓGICA DE DOMINIO (onboarding, gate biométrico de turno, máquinas de estado de
 * aprobación/antecedentes/KYC, modelo de HOLDS multi-causa, decisiones `created`/`removed`, cifrado del DNI,
 * tombstone/purge, idempotencia) vive ENTERA en el service. Este repo solo hace acceso a datos y CRISTALIZA
 * los INVARIANTES DE QUERY que NO deben poder cambiarse desde afuera:
 *   - los CAS optimistas de transición de estado llevan su predicado FIJO HARDCODEADO en el WHERE (el gate de
 *     face-match `dniFaceMatchedAt/licenseFaceMatchedAt != null` de la aprobación, el `suspendedAt: null` +
 *     `faceEmbedding.isEmpty:false` del gate biométrico de turno, el destino de cada transición) — el service
 *     solo aporta el CONJUNTO DE FUENTES legales derivado de la máquina y los valores computados;
 *   - el `upsert` del hold lleva `update: {}` HARDCODEADO (idempotencia del cooldown: una redelivery NO extiende
 *     el `expiresAt` — FOUNDATION del modelo de holds);
 *   - las mutaciones de estado y sus eventos (driver.registered/verified/rejected/suspended/reactivated/
 *     resubmitted/went_online/went_offline, biometric.enrolled/enroll_rejected/failed) se emiten al outbox
 *     DENTRO de la misma tx que su escritura (atomicidad estado↔evento, CLAUDE §3).
 *
 * Como onboarding, aprobación, holds, turno y purge interleavan lecturas y decisiones de dominio DENTRO de una
 * misma transacción, el repo expone `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que
 * reciben el `tx` opaco: el service ORQUESTA la secuencia sin tocar nunca `this.prisma` ni `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  BackgroundCheckStatus,
  DriverStatus,
  SuspensionCause,
  type Driver,
  type User,
} from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type DriverTx = Prisma.TransactionClient;

/** Fila de la cola de aprobación (proyección para el operador; sin PII cruda). */
export interface PendingApprovalRow {
  id: string;
  userId: string;
  licenseNumber: string | null;
  legalName: string | null;
}

/** Slice de identidad leído de la PRIMARIA para el gate A10 de `updatePersonalInfo` (no réplica: sin lag). */
export interface DriverIdentityGate {
  backgroundCheckStatus: BackgroundCheckStatus;
  dniHash: string | null;
  legalName: string | null;
  birthDate: Date | null;
}

/** Estado fresco del conductor que ve el count===0 del CAS de turno (error honesto). */
export interface DriverShiftState {
  currentStatus: DriverStatus;
  suspendedAt: Date | null;
  faceEmbedding: number[];
}

/** Datos del upsert de un hold (los arma el service; el repo persiste con `update: {}` idempotente hardcodeado). */
export interface HoldUpsertData {
  driverId: string;
  cause: SuspensionCause;
  causeRef: string;
  reason: string;
  createdAt: Date;
  expiresAt?: Date;
}

@Injectable()
export class DriversRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas no transaccionales (réplica salvo donde se indica primary) ───────────────────────────────

  /** Usuario por id (onboard/updatePhoto leen `deletedAt`/`type`). Réplica. */
  findUserById(userId: string): Promise<User | null> {
    return this.prisma.read.user.findUnique({ where: { id: userId } });
  }

  /** Cola de aprobación PENDING, FIFO (más antiguas), acotada por `pageSize` (índice compuesto). Réplica. */
  listPendingApproval(pageSize: number): Promise<PendingApprovalRow[]> {
    return this.prisma.read.driver.findMany({
      where: { backgroundCheckStatus: BackgroundCheckStatus.PENDING },
      select: { id: true, userId: true, licenseNumber: true, legalName: true },
      orderBy: { createdAt: 'asc' },
      take: pageSize,
    });
  }

  /** `userId` de un conductor (backstop del reseal por driverId). Réplica. */
  findDriverUserId(driverId: string): Promise<{ userId: string } | null> {
    return this.prisma.read.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
  }

  /** driverIds con hold TEMPORAL vencido (`expiresAt != null AND < now`) — input batch del sweeper. Réplica. */
  findExpiredHoldDriverIds(now: Date): Promise<{ driverId: string }[]> {
    return this.prisma.read.driverSuspensionHold.findMany({
      where: { expiresAt: { not: null, lt: now } },
      select: { driverId: true },
    });
  }

  /**
   * ADR-022 §P-A · ¿el conductor tiene un hold DEBT_BLOCKED activo? Réplica (gate barato de fail-fast en startShift:
   * solo se consulta cuando `suspendedAt` ya está seteado, para dar un mensaje HONESTO "saldá tu deuda" en vez del
   * genérico "suspendido"). No es la autoridad del bloqueo (esa es `suspendedAt`, derivado del conjunto de holds).
   */
  async hasDebtBlockHold(driverId: string): Promise<boolean> {
    const hold = await this.prisma.read.driverSuspensionHold.findUnique({
      where: {
        driverId_cause_causeRef: { driverId, cause: SuspensionCause.DEBT_BLOCKED, causeRef: '' },
      },
      select: { driverId: true },
    });
    return hold !== null;
  }

  /** Conductor por `userId` (@unique). Réplica. Gates baratos de fail-fast; la autoridad final es el CAS en tx. */
  findDriverByUserId(userId: string): Promise<Driver | null> {
    return this.prisma.read.driver.findUnique({ where: { userId } });
  }

  /** Conductor por id de perfil. Réplica. */
  findDriverById(driverId: string): Promise<Driver | null> {
    return this.prisma.read.driver.findUnique({ where: { id: driverId } });
  }

  /** Existencia del conductor (clearBiometricLockout). Réplica. */
  findDriverIdById(driverId: string): Promise<{ id: string } | null> {
    return this.prisma.read.driver.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
  }

  /**
   * ¿El `dniHash` (blind index) YA está en OTRA cuenta? Excluye `userId` (resume del wizard con SU MISMO DNI).
   * Solo `id`; la garantía DURA de unicidad la da el `@unique(dni_hash)` + el backstop P2002 del write. Réplica.
   */
  findConflictingDniOwner(dniHash: string, excludeUserId: string): Promise<{ id: string } | null> {
    return this.prisma.read.driver.findFirst({
      where: { dniHash, NOT: { userId: excludeUserId } },
      select: { id: true },
    });
  }

  /**
   * Slice de identidad para el gate A10 de `updatePersonalInfo`. Lee de la PRIMARIA (no réplica) a PROPÓSITO:
   * el gate "no reescribir PII con el alta ya aprobada" NO puede depender del lag de réplica.
   */
  findDriverIdentityGateOnPrimary(userId: string): Promise<DriverIdentityGate | null> {
    return this.prisma.write.driver.findUnique({
      where: { userId },
      select: { backgroundCheckStatus: true, dniHash: true, legalName: true, birthDate: true },
    });
  }

  // ── Escrituras no transaccionales (primary) ───────────────────────────────────────────────────────────

  /** Persiste el avatar del conductor en `User.photoUrl`. Devuelve el user actualizado. */
  updateUserPhoto(userId: string, photoUrl: string): Promise<User> {
    return this.prisma.write.user.update({
      where: { id: userId },
      data: { photoUrl },
    });
  }

  /**
   * Registro de auditoría del intento biométrico EXITOSO de startShift, en su PROPIA escritura ANTES del CAS
   * (evidencia que persiste independiente de si la transición posterior pasa/falla, #13). Primary.
   */
  async createBiometricCheck(data: Prisma.BiometricCheckUncheckedCreateInput): Promise<void> {
    await this.prisma.write.biometricCheck.create({ data });
  }

  /**
   * CAS de la transición del eje DriverStatus disparada por el ciclo de vida del VIAJE (moveStatusForTrip). El
   * conjunto de fuentes legales (derivado de la máquina, recortado por el service) viaja en el WHERE; el destino
   * lo aporta el service. count>0 ⇒ movió (o re-aplicación idempotente from===to); count===0 ⇒ transición ilegal.
   */
  async casMoveStatus(
    driverId: string,
    sources: DriverStatus[],
    to: DriverStatus,
  ): Promise<{ count: number }> {
    return this.prisma.write.driver.updateMany({
      where: { id: driverId, currentStatus: { in: sources } },
      data: { currentStatus: to },
    });
  }

  /** Persiste un evento en el outbox FUERA de tx (rechazo forense del enrol: escritura propia, 422 igual). */
  async enqueueOutboxNonTx(envelope: EventEnvelope<unknown>, aggregateId: string): Promise<void> {
    await persistOutboxEvent(this.prisma.write, envelope, aggregateId);
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA lecturas/escrituras tx-scoped del
   * repo interleavadas con su lógica de dominio (máquinas de estado, holds, gates). Todo lo que corre en `work`
   * es una única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: DriverTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: DriverTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  // materializeDriverShell (unit-of-work · alta idempotente orden-independiente) ---------------------------

  /**
   * `INSERT ... ON CONFLICT DO NOTHING` del cascarón Driver (primitiva atómica del alta). count===1 ⇒ ESTA
   * llamada creó la fila (el ganador emite driver.registered); count===0 ⇒ ya existía (el otro paso del wizard).
   */
  async createDriverIfAbsent(
    tx: DriverTx,
    data: Prisma.DriverCreateManyInput,
  ): Promise<{ count: number }> {
    return tx.driver.createMany({ data, skipDuplicates: true });
  }

  /**
   * Brazo UPDATE del alta por CAS (rama "ya existía"): actualiza el slice por `userId` SOLO si matchea el guard
   * ATÓMICO (`backgroundCheckStatus != CLEARED` para el TOCTOU A10). count===0 ⇒ el estado cambió bajo la carrera.
   */
  async casUpdateDriverByUserId(
    tx: DriverTx,
    userId: string,
    guard: Prisma.DriverWhereInput,
    data: Prisma.DriverUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({ where: { userId, ...guard }, data });
  }

  /** Brazo UPDATE plano del alta (sin guard): actualiza el slice por PK (`userId` @unique). */
  async updateDriverByUserId(
    tx: DriverTx,
    userId: string,
    data: Prisma.DriverUpdateInput,
  ): Promise<void> {
    await tx.driver.update({ where: { userId }, data });
  }

  /** Relee el agregado completo tras materializar (invariante: la fila existe). */
  getDriverByUserIdOrThrow(tx: DriverTx, userId: string): Promise<Driver> {
    return tx.driver.findUniqueOrThrow({ where: { userId } });
  }

  // Lecturas tx-scoped (dato FRESCO, sin lag de réplica ni TOCTOU) ---------------------------------------

  /** Conductor completo por id, DENTRO de la tx (approve/reject/suspend/purge). */
  findDriverByIdTx(tx: DriverTx, driverId: string): Promise<Driver | null> {
    return tx.driver.findUnique({ where: { id: driverId } });
  }

  /** Conductor completo por `userId`, DENTRO de la tx (resubmit). */
  findDriverByUserIdTx(tx: DriverTx, userId: string): Promise<Driver | null> {
    return tx.driver.findUnique({ where: { userId } });
  }

  /** Usuario por id, DENTRO de la tx (sincronización del kycStatus). */
  findUserByIdTx(tx: DriverTx, userId: string): Promise<User | null> {
    return tx.user.findUnique({ where: { id: userId } });
  }

  /** `{ id, userId }` por id de perfil, DENTRO de la tx (vías de suspensión que revocan sesión post-commit). */
  findDriverIdUserByIdTx(
    tx: DriverTx,
    driverId: string,
  ): Promise<{ id: string; userId: string } | null> {
    return tx.driver.findUnique({
      where: { id: driverId },
      select: { id: true, userId: true },
    });
  }

  /** `{ id }` por `userId`, DENTRO de la tx (resolución User.id→Driver.id de las vías keyeadas por User.id). */
  findDriverIdByUserIdTx(tx: DriverTx, userId: string): Promise<{ id: string } | null> {
    return tx.driver.findUnique({ where: { userId }, select: { id: true } });
  }

  /** `{ id }` por id de perfil, DENTRO de la tx (guard de existencia anti poison-pill). */
  findDriverIdByIdTx(tx: DriverTx, driverId: string): Promise<{ id: string } | null> {
    return tx.driver.findUnique({ where: { id: driverId }, select: { id: true } });
  }

  /** `backgroundCheckStatus` fresco, DENTRO de la tx (rama count===0 de approve/reject/resubmit). */
  findDriverBackgroundStatusTx(
    tx: DriverTx,
    driverId: string,
  ): Promise<{ backgroundCheckStatus: BackgroundCheckStatus } | null> {
    return tx.driver.findUnique({
      where: { id: driverId },
      select: { backgroundCheckStatus: true },
    });
  }

  /** Estado de turno fresco, DENTRO de la tx (rama count===0 del CAS de startShift → error honesto). */
  findDriverShiftStateTx(tx: DriverTx, driverId: string): Promise<DriverShiftState | null> {
    return tx.driver.findUnique({
      where: { id: driverId },
      select: { currentStatus: true, suspendedAt: true, faceEmbedding: true },
    });
  }

  /** `currentStatus` fresco, DENTRO de la tx (rama count===0 del CAS de setStatus). */
  findDriverCurrentStatusTx(
    tx: DriverTx,
    driverId: string,
  ): Promise<{ currentStatus: DriverStatus } | null> {
    return tx.driver.findUnique({
      where: { id: driverId },
      select: { currentStatus: true },
    });
  }

  // Escrituras tx-scoped genéricas -----------------------------------------------------------------------

  /** Update por id, DENTRO de la tx. El service arma la `data` de dominio (enrol/binding face-match). */
  async updateDriverById(
    tx: DriverTx,
    driverId: string,
    data: Prisma.DriverUpdateInput,
  ): Promise<void> {
    await tx.driver.update({ where: { id: driverId }, data });
  }

  /** Sincroniza el `kycStatus` del usuario, DENTRO de la tx (par de la transición del conductor). */
  async updateUser(tx: DriverTx, userId: string, data: Prisma.UserUpdateInput): Promise<void> {
    await tx.user.update({ where: { id: userId }, data });
  }

  /** Auditoría del intento biométrico FALLIDO, DENTRO de su propia tx de evidencia (junto al outbox). */
  async createBiometricCheckTx(
    tx: DriverTx,
    data: Prisma.BiometricCheckUncheckedCreateInput,
  ): Promise<void> {
    await tx.biometricCheck.create({ data });
  }

  // CAS de transición de estado (predicado + destino HARDCODEADOS · el service aporta solo las fuentes) ---

  /**
   * CAS de la APROBACIÓN: `backgroundCheckStatus in claimSources` → CLEARED. Los GATES de face-match
   * (`dniFaceMatchedAt != null` Y `licenseFaceMatchedAt != null`) van HARDCODEADOS en el WHERE — el gate de
   * frescura es ATÓMICO con la transición (si un resubmit/enrol concurrente nulifica el binding, la fila ya NO
   * matchea → count 0 → NO se aprueba ni se emite driver.verified). El service aporta solo `claimSources`.
   */
  async casApproveTransition(
    tx: DriverTx,
    driverId: string,
    claimSources: BackgroundCheckStatus[],
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({
      where: {
        id: driverId,
        backgroundCheckStatus: { in: claimSources },
        dniFaceMatchedAt: { not: null },
        licenseFaceMatchedAt: { not: null },
      },
      data: { backgroundCheckStatus: BackgroundCheckStatus.CLEARED },
    });
  }

  /**
   * CAS del RECHAZO: `backgroundCheckStatus in rejectSources` → REJECTED (+ motivo + momento). Destino
   * HARDCODEADO; el service aporta las fuentes y los valores (`reason`, `rejectedAt`).
   */
  async casRejectTransition(
    tx: DriverTx,
    driverId: string,
    rejectSources: BackgroundCheckStatus[],
    reason: string,
    rejectedAt: Date,
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({
      where: { id: driverId, backgroundCheckStatus: { in: rejectSources } },
      data: {
        backgroundCheckStatus: BackgroundCheckStatus.REJECTED,
        rejectionReason: reason,
        rejectedAt,
      },
    });
  }

  /**
   * CAS del REENVÍO a revisión: `backgroundCheckStatus in resubmitSources` → PENDING, limpiando el motivo Y
   * RESETEANDO AMBOS BINDINGS (DNI + licencia) a "no corrido" — invariante de FRESCURA por-ciclo HARDCODEADO
   * en la MISMA escritura que lleva a PENDING (un re-approve OBLIGA a re-correr los cotejos contra el material
   * corregido). El service aporta solo `resubmitSources`.
   */
  async casResubmitTransition(
    tx: DriverTx,
    driverId: string,
    resubmitSources: BackgroundCheckStatus[],
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({
      where: { id: driverId, backgroundCheckStatus: { in: resubmitSources } },
      data: {
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
        rejectionReason: null,
        rejectedAt: null,
        dniFaceMatched: null,
        dniFaceMatchScore: null,
        dniFaceMatchedAt: null,
        licenseFaceMatched: null,
        licenseFaceMatchScore: null,
        licenseFaceMatchedAt: null,
      },
    });
  }

  /**
   * CAS del GATE BIOMÉTRICO DE TURNO: `currentStatus in entryStates` Y `suspendedAt: null` Y
   * `faceEmbedding.isEmpty: false` (predicados de seguridad HARDCODEADOS, todo sobre el dato FRESCO) → AVAILABLE
   * + `lastVerifiedAt`. count===0 ⇒ suspendido / sin biometría / double-shift. El service aporta `entryStates`.
   */
  async casStartShift(
    tx: DriverTx,
    driverId: string,
    entryStates: DriverStatus[],
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({
      where: {
        id: driverId,
        suspendedAt: null,
        faceEmbedding: { isEmpty: false },
        currentStatus: { in: entryStates },
      },
      data: { currentStatus: DriverStatus.AVAILABLE, lastVerifiedAt: new Date() },
    });
  }

  /**
   * CAS del cambio de estado autoservicio (fin de turno / pausa): `currentStatus in statusSources` → `status`.
   * El service aporta las fuentes (excluido el destino, para la idempotencia del double-tap) y el destino.
   */
  async casSetStatus(
    tx: DriverTx,
    driverId: string,
    statusSources: DriverStatus[],
    status: DriverStatus,
  ): Promise<{ count: number }> {
    return tx.driver.updateMany({
      where: { id: driverId, currentStatus: { in: statusSources } },
      data: { currentStatus: status },
    });
  }

  // Holds (modelo de suspensión multi-causa) ------------------------------------------------------------

  /** El hold MÁS VIEJO del conductor (fija el momento original de `suspendedAt`), DENTRO de la tx. 0..1 fila. */
  findOldestHoldCreatedAt(tx: DriverTx, driverId: string): Promise<{ createdAt: Date } | null> {
    return tx.driverSuspensionHold.findFirst({
      where: { driverId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
  }

  /** Escribe el campo DERIVADO `Driver.suspendedAt` (recomputado por el service), DENTRO de la tx. Idempotente. */
  async setDriverSuspendedAt(
    tx: DriverTx,
    driverId: string,
    suspendedAt: Date | null,
  ): Promise<void> {
    await tx.driver.update({ where: { id: driverId }, data: { suspendedAt } });
  }

  /** ¿Existe YA el hold exacto (natural key)? (discrimina "created" de "ya existía"), DENTRO de la tx. */
  findHoldByNaturalKey(
    tx: DriverTx,
    driverId: string,
    cause: SuspensionCause,
    causeRef: string,
  ): Promise<{ id: string } | null> {
    return tx.driverSuspensionHold.findUnique({
      where: { driverId_cause_causeRef: { driverId, cause, causeRef } },
      select: { id: true },
    });
  }

  /**
   * Upsert idempotente del hold por natural key. `update: {}` HARDCODEADO: una re-entrega del MISMO cruce NO
   * extiende `expiresAt` ni reescribe `createdAt`/`reason` (protege el cooldown). El create lleva los datos frescos.
   */
  async upsertHold(tx: DriverTx, data: HoldUpsertData): Promise<void> {
    const { driverId, cause, causeRef, reason, createdAt, expiresAt } = data;
    await tx.driverSuspensionHold.upsert({
      where: { driverId_cause_causeRef: { driverId, cause, causeRef } },
      create: { driverId, cause, causeRef, reason, createdAt, expiresAt },
      update: {},
    });
  }

  /** Cuenta holds que matchean `where` (acotado al conductor), DENTRO de la tx (gate de reactivateForCompliance). */
  countHolds(
    tx: DriverTx,
    driverId: string,
    where: Prisma.DriverSuspensionHoldWhereInput,
  ): Promise<number> {
    return tx.driverSuspensionHold.count({ where: { driverId, ...where } });
  }

  /** Borra los holds que matchean `where` (acotado al conductor), DENTRO de la tx. Idempotente (0 = no-op). */
  async deleteHolds(
    tx: DriverTx,
    driverId: string,
    where: Prisma.DriverSuspensionHoldWhereInput,
  ): Promise<{ count: number }> {
    return tx.driverSuspensionHold.deleteMany({ where: { driverId, ...where } });
  }

  // Purge (hard delete atómico · derecho al olvido / re-registro) ----------------------------------------

  /** Borra la fila Driver (devuelve la fila borrada para el contador honesto), DENTRO de la tx. */
  deleteDriverById(tx: DriverTx, driverId: string): Promise<Driver> {
    return tx.driver.delete({ where: { id: driverId } });
  }

  /** Borra los métodos de auth del usuario, DENTRO de la tx. */
  deleteAuthMethodsByUser(tx: DriverTx, userId: string): Promise<{ count: number }> {
    return tx.authMethod.deleteMany({ where: { userId } });
  }

  /** Borra los intentos biométricos del usuario, DENTRO de la tx. */
  deleteBiometricChecksByUser(tx: DriverTx, userId: string): Promise<{ count: number }> {
    return tx.biometricCheck.deleteMany({ where: { userId } });
  }

  /** Borra los consentimientos del usuario, DENTRO de la tx. */
  deleteConsentsByUser(tx: DriverTx, userId: string): Promise<{ count: number }> {
    return tx.consent.deleteMany({ where: { userId } });
  }

  /** Borra la fila User AL FINAL (libera el teléfono @unique), DENTRO de la tx. */
  async deleteUserById(tx: DriverTx, userId: string): Promise<void> {
    await tx.user.delete({ where: { id: userId } });
  }
}
