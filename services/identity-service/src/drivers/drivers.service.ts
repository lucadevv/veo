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
  UnprocessableEntityError,
  uuidv7,
} from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { seal } from '../common/secret-box';
import { maskDniForOwner } from '../common/document';
import { REDIS } from '../infra/redis';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricDniMatchResult,
  type BiometricProvider,
} from '../ports/biometric/biometric.port';
import {
  BackgroundCheckStatus,
  DriverStatus,
  KycStatus,
  Prisma,
  SuspensionSource,
} from '../generated/prisma';
import { backgroundCheckMachine, isBackgroundCleared } from '../domain/background-check';
import { hasFaceEmbedding } from '../domain/face-embedding';
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

/**
 * Estados DESDE los que `to` es alcanzable en el eje BackgroundCheckStatus (inversa de la tabla de la máquina).
 * Gemelo de `driverStatusSources` para el eje de antecedentes: alimenta el CAS atómico de `approve()`
 * (`updateMany({ where: { backgroundCheckStatus: { in: backgroundCheckSources(CLEARED) } } })`), que mueve el
 * estado en el MISMO statement que valida que era una transición legal — sin check-then-act, así dos approve()
 * concurrentes no pueden ambos ganar la carrera (solo UNO matchea → solo UNO emite driver.verified). Deriva de
 * `backgroundCheckMachine.transitions` (única fuente de verdad del eje): cero strings mágicos. Incluye `to`
 * mismo si la tabla lo permite (re-aplicación idempotente).
 */
function backgroundCheckSources(to: BackgroundCheckStatus): BackgroundCheckStatus[] {
  const transitions = backgroundCheckMachine.transitions;
  return (Object.keys(transitions) as BackgroundCheckStatus[]).filter((from) =>
    backgroundCheckMachine.canTransition(from, to),
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

/**
 * Resultado de un HARD purge del conductor: el `userId` liberado (para que el orquestador del admin-bff
 * encadene el borrado en fleet/media, que indexan por User.id) + los contadores por tabla borrada.
 */
export interface DriverPurgeResult {
  userId: string;
  deleted: {
    driver: number;
    authMethods: number;
    biometricChecks: number;
    consents: number;
    user: number;
  };
}

@Injectable()
export class DriversService {
  private readonly minScore: number;
  /** Clave de cifrado del DNI del conductor en reposo (AES-256-GCM · secret-box). KMS en prod. */
  private readonly dniEncKey: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BIOMETRIC_PROVIDER) private readonly biometric: BiometricProvider,
    config: ConfigService<Env, true>,
  ) {
    this.minScore = config.getOrThrow<number>('BIOMETRIC_MIN_SCORE');
    this.dniEncKey = config.getOrThrow<string>('DRIVER_DNI_ENC_KEY');
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

  listPendingApproval(): Promise<
    { id: string; userId: string; licenseNumber: string | null; legalName: string | null }[]
  > {
    // legalName = el nombre que el conductor cargó en el onboarding (lo que ve el operador en la cola;
    // sin esto la tabla solo mostraba UUIDs y no se podía distinguir un conductor de otro).
    return this.prisma.read.driver.findMany({
      where: { backgroundCheckStatus: BackgroundCheckStatus.PENDING },
      select: { id: true, userId: true, licenseNumber: true, legalName: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Operador aprueba antecedentes → conductor habilitado (KYC VERIFIED). Emite driver.verified.
   *
   * GATE BIOMÉTRICO SERVER-SIDE (defensa en profundidad · diferenciador no negociable VEO): un conductor
   * NO puede ser aprobado —es decir, alcanzar KYC VERIFIED— sin haber enrolado su biometría facial de
   * referencia (`faceEmbedding`). Este es el choke point AUTORITATIVO y curl-proof: aunque la UI o el
   * admin-bff fallaran en chequearlo, la transición a aprobado se BLOQUEA aquí, dentro de la MISMA tx que
   * valida los antecedentes, antes de cualquier escritura (fail-closed, cero efectos). El gate de TURNO
   * (startShift, BR-I02) ya exigía el embedding para verificar en vivo; este lo exige ANTES, en la
   * aprobación, para que un conductor sin biometría no llegue siquiera a quedar habilitado. La lectura del
   * embedding vive DENTRO de la tx (sobre el dato fresco, no la réplica): sin TOCTOU con un enrollFace
   * concurrente. Error tipado 409 (ConflictError) `biometría no enrolada`.
   *
   * GATE DE EJECUCIÓN DEL BINDING DNI↔selfie (server-truth, fail-closed · diferenciador no negociable VEO):
   * además del enrolamiento biométrico, este choke point exige que el face-match DNI↔selfie SE HAYA EJECUTADO
   * antes de aprobar. El predicado tipado es `dniFaceMatchedAt != null` (`matchDniFace()` setea los 3 campos
   * del binding en UNA escritura atómica → `dniFaceMatchedAt = null` ⇔ el match NUNCA corrió). Curl-proof:
   * aunque la UI muestre el binding, la API se NIEGA a aprobar a ciegas sin haber corrido el cotejo. La
   * lectura vive DENTRO de la tx, sobre el MISMO driver que se va a transicionar (sin TOCTOU con un
   * matchDniFace concurrente). Error tipado 409 (ConflictError) `face-match no ejecutado`.
   *
   * DISTINCIÓN CRÍTICA · el gate es "SE EJECUTÓ", NO "MATCHEÓ": un `dniFaceMatched === false` (veredicto
   * NO_MATCH) DEBE seguir permitiendo la aprobación. Razones: (1) el match puede dar NO_MATCH por una foto de
   * DNI de mala calidad sin que haya fraude — un falso negativo NO debe bloquear mecánicamente la habilitación;
   * (2) el veredicto lo decide el OPERADOR que lo VIO (UI 3C), no la máquina. La política es: el binding TIENE
   * que haberse corrido (gate duro, curl-proof), pero el VEREDICTO es criterio humano. NO se lee
   * `dniFaceMatched` (el veredicto) para gatear: solo `dniFaceMatchedAt` (la ejecución).
   */
  async approve(driverId: string): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const user = await tx.user.findUnique({ where: { id: driver.userId } });
      if (!user) throw new NotFoundError('Usuario del conductor no encontrado');
      // GATE BIOMÉTRICO (server-truth, fail-closed): sin embedding de referencia enrolado NO hay
      // aprobación. Mismo predicado que el gate de turno (`hasFaceEmbedding`) → fuente única de
      // "biométricamente enrolado". Corta ANTES de los asserts de máquina y de toda escritura.
      if (!hasFaceEmbedding(driver)) {
        throw new ConflictError('No se puede aprobar: el conductor no enroló su biometría facial', {
          driverId,
        });
      }
      // GATE DE EJECUCIÓN DEL BINDING (server-truth, fail-closed): el face-match DNI↔selfie DEBE haberse
      // ejecutado antes de aprobar. `dniFaceMatchedAt == null` ⇔ matchDniFace() nunca corrió (los 3 campos
      // del binding se setean juntos en una escritura atómica). Curl-proof: no se aprueba a ciegas. Es gate
      // de EJECUCIÓN, NO de veredicto: un dniFaceMatched===false (NO_MATCH) SÍ pasa — el operador lo vio y
      // decide. Se lee del `driver` FRESCO de la tx (mismo que se transiciona): sin TOCTOU. Corta ANTES de
      // los asserts de máquina y de toda escritura.
      if (driver.dniFaceMatchedAt == null) {
        throw new ConflictError(
          'No se puede aprobar: el face-match DNI↔selfie no se ejecutó. Corré el cotejo antes de aprobar.',
          { driverId },
        );
      }
      // Asserts de máquina TIPADOS: validan que la transición es LEGAL sobre el dato fresco (un from fuera
      // del enum / un CLEARED→PENDING ilegal fallan acá, antes del CAS). La GANANCIA de la carrera, en cambio,
      // la decide el CAS de abajo, no estos asserts (un check-then-act secuencial no protege del concurrente).
      backgroundCheckMachine.assertTransition(
        driver.backgroundCheckStatus,
        BackgroundCheckStatus.CLEARED,
      );
      kycStatusMachine.assertTransition(user.kycStatus, KycStatus.VERIFIED);
      // TRANSICIÓN POR CAS ATÓMICO (espeja suspend()/startShift()): el estado fuente válido viaja en el WHERE
      // del updateMany (`backgroundCheckStatus in sources(CLEARED)` = {PENDING, REJECTED, CLEARED}, derivado de
      // la máquina, cero strings mágicos). Dos approve() concurrentes leen ambos PENDING y pasan ambos el assert
      // (READ COMMITTED), pero solo UNO matchea el CAS: el segundo ve count===0 porque la fila ya está en CLEARED
      // y PENDING ya no está en el WHERE... salvo que CLEARED ∈ sources (re-aplicación idempotente). Para que el
      // CAS DISCRIMINE al perdedor de la carrera, el WHERE exige el estado fuente que AÚN NO es CLEARED: PENDING
      // o REJECTED. Así el ganador transiciona PENDING/REJECTED→CLEARED (count 1, emite); el perdedor ya ve
      // CLEARED y NO matchea (count 0, no-op idempotente SIN re-emitir driver.verified).
      const claimSources = backgroundCheckSources(BackgroundCheckStatus.CLEARED).filter(
        (from) => from !== BackgroundCheckStatus.CLEARED,
      );
      // GATE DE FACE-MATCH ATÓMICO CON LA TRANSICIÓN (cierra el TOCTOU del pre-read): además del estado fuente,
      // el WHERE del CAS exige `dniFaceMatchedAt != null`. El pre-read de arriba da el 409 amigable en el caso
      // común (curl-proof + UX), PERO no es atómico: entre ese read y este write, un resubmit()/enrollFace()
      // CONCURRENTE puede nulificar el binding (ambos lo resetean en su misma tx). Plegando el predicado en el
      // CAS, si el binding se nulifica bajo nuestros pies la fila ya NO matchea el WHERE → count 0 → NO se aprueba
      // ni se emite driver.verified. Es comparación contra constante (`not: null`), soportada por Prisma — no
      // hace falta comparar dos columnas entre sí. Así el gate de frescura es ATÓMICO con la transición.
      const claim = await tx.driver.updateMany({
        where: {
          id: driverId,
          backgroundCheckStatus: { in: claimSources },
          dniFaceMatchedAt: { not: null },
        },
        data: { backgroundCheckStatus: BackgroundCheckStatus.CLEARED },
      });
      if (claim.count === 0) {
        // count 0 tiene DOS causas, ambas resueltas como no-op idempotente SIN re-emitir driver.verified:
        // (a) IDEMPOTENTE: otra tx concurrente ya aprobó (la fila ya está CLEARED, fuera del `in` del WHERE) — el
        //     pre-read ya pasó (binding presente), así que NO es una carrera de nulificación: devolvemos el estado
        //     ya-aprobado, honesto, sin tocar user ni outbox (esto es lo que evita el double-emit).
        // (b) CARRERA DE NULIFICACIÓN: un resubmit()/enrollFace() concurrente nulificó dniFaceMatchedAt entre el
        //     pre-read y este CAS. El binding ya NO es fresco → fail-closed: NO aprobamos (no re-emitimos). Tratarlo
        //     como no-op (en vez de lanzar) es seguro y honesto: la garantía dura ya la dio el WHERE (no se aprobó);
        //     el conductor quedó PENDING/re-enrolado y deberá re-correr el match — el operador reintentará el approve.
        // En ambos casos NO re-emitimos driver.verified (cero double-emit) y devolvemos el estado real de la fila.
        const current = await tx.driver.findUnique({
          where: { id: driverId },
          select: { backgroundCheckStatus: true },
        });
        return {
          id: driver.id,
          backgroundCheckStatus: current?.backgroundCheckStatus ?? driver.backgroundCheckStatus,
        };
      }
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
      return { id: driver.id, backgroundCheckStatus: BackgroundCheckStatus.CLEARED };
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
        // El SOURCE (DISCIPLINARY) registra que esta suspensión la originó un operador: la reactivación
        // manual (reactivate) SOLO puede levantar esta fuente (fail-closed contra levantar docs vencidos).
        data: { suspendedAt, suspensionSource: SuspensionSource.DISCIPLINARY },
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
   * REACTIVACIÓN MANUAL del conductor por un operador admin (la inversa de suspend(), acción de SAFETY).
   * Limpia `Driver.suspendedAt` + `suspensionSource` —los mismos campos que el gate de inicio de turno
   * (startShift) y el eligibility gate de dispatch leen para bloquear (BR-I02)—, así un conductor que
   * estaba suspendido vuelve a poder iniciar turno (sujeto SIEMPRE al gate biométrico, ver punto 4). Emite
   * `driver.reactivated` por OUTBOX en la MISMA tx (igual que suspend emite driver.suspended) para que
   * audit/admin-bff reaccionen.
   *
   * FAIL-CLOSED (causa raíz del diseño): el operador SOLO puede revertir suspensiones que él originó
   * (DISCIPLINARY). Una suspensión por documento crítico vencido (DOCUMENT_EXPIRED, vía
   * fleet.driver_suspended) NO se levanta a mano —re-habilitar a un conductor con SOAT/licencia vencida
   * es un bug de seguridad inaceptable—: se levanta cuando el conductor regulariza sus documentos. Las
   * filas LEGACY con suspendedAt seteado pero suspensionSource null se tratan como NO-DISCIPLINARY (también
   * rechazadas, fail-closed: ante la duda del origen, NO reactivamos).
   *
   * SEMÁNTICA (en orden):
   *   1. Carga el driver en la tx; 404 si no existe.
   *   2. Si NO está suspendido (suspendedAt null) → 409 (no hay nada que reactivar).
   *   3. Si la suspensión NO es DISCIPLINARY (DOCUMENT_EXPIRED o source null legacy) → 403 (fail-closed).
   *   4. Re-valida eligibility mínima: licencia vencida → 403. (El gate operativo COMPLETO —biometría, KYC—
   *      lo sigue imponiendo startShift BR-I02; reactivar NO devuelve al conductor a AVAILABLE ni toca
   *      currentStatus: solo limpia la suspensión.)
   *   5. CAS clear (where suspendedAt not null + source DISCIPLINARY): si count 0, releemos para un error
   *      HONESTO (ya reactivado por una carrera, o el source cambió bajo nuestros pies → 409/403).
   *   6. Emite driver.reactivated por OUTBOX (misma tx).
   */
  async reactivate(driverId: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      // 2) Reactivar a un conductor NO suspendido no tiene sentido (no es idempotente como suspend: no hay
      //    estado al que llevar). 409 honesto en vez de un no-op silencioso que mentiría "reactivado".
      if (driver.suspendedAt === null) {
        throw new ConflictError('El conductor no está suspendido');
      }
      // 3) FAIL-CLOSED por ORIGEN: el operador solo revierte suspensiones DISCIPLINARY que él originó.
      //    DOCUMENT_EXPIRED no se levanta a mano. Una fila legacy con source null se trata como
      //    NO-DISCIPLINARY (ante la duda del origen, NO reactivamos — es la posición segura).
      if (driver.suspensionSource !== SuspensionSource.DISCIPLINARY) {
        throw new ForbiddenError(
          'No se puede reactivar: la suspensión es por documentos vencidos; se levanta cuando el conductor regulariza sus documentos',
        );
      }
      // 4) Re-validación mínima de eligibility: NO reactivamos sobre una licencia vencida. El gate operativo
      //    completo (biometría, KYC) lo sigue imponiendo startShift (BR-I02); acá solo evitamos el caso
      //    obvio de levantar la suspensión a un conductor cuya licencia ya venció.
      if (driver.licenseExpiresAt && driver.licenseExpiresAt.getTime() < Date.now()) {
        throw new ForbiddenError('No se puede reactivar: la licencia está vencida');
      }
      // 5) CAS clear: solo limpia si SIGUE suspendido Y la fuente SIGUE siendo DISCIPLINARY (defensa contra
      //    una carrera que ya reactivó, o un fleet.driver_suspended que reescribió la fuente bajo nosotros).
      const result = await tx.driver.updateMany({
        where: {
          id: driverId,
          suspendedAt: { not: null },
          suspensionSource: SuspensionSource.DISCIPLINARY,
        },
        data: { suspendedAt: null, suspensionSource: null },
      });
      if (result.count === 0) {
        // Releemos para un error HONESTO (espeja startShift): o ya lo reactivó una carrera, o la fuente
        // cambió a DOCUMENT_EXPIRED (un docto venció entre nuestra lectura y el CAS) → fail-closed.
        const current = await tx.driver.findUnique({
          where: { id: driverId },
          select: { suspendedAt: true, suspensionSource: true },
        });
        if (!current) throw new NotFoundError('Conductor no encontrado');
        if (current.suspendedAt === null) {
          throw new ConflictError('El conductor ya fue reactivado');
        }
        throw new ForbiddenError(
          'No se puede reactivar: la suspensión es por documentos vencidos; se levanta cuando el conductor regulariza sus documentos',
        );
      }
      // 6) Emite driver.reactivated por OUTBOX en la MISMA tx (igual que suspend): admin-bff proyecta el
      //    status de SUSPENDED de vuelta a ACTIVE; audit deja la traza inmutable de la decisión.
      const envelope = createEnvelope({
        eventType: 'driver.reactivated',
        producer: 'identity-service',
        payload: {
          driverId: driver.id,
          reactivatedAt: new Date().toISOString(),
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
   * REJECTED (p. ej. un conductor ya CLEARED no puede "reenviar"). Emite `driver.resubmitted` por OUTBOX
   * (misma tx) → el admin-bff proyecta status=PENDING en el read-model, cerrando el double-source (la
   * lista dejaba de mostrar REJECTED stale frente al detalle PENDING en vivo).
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
          // RESET DEL BINDING DNI↔selfie POR-CICLO (causa raíz, fail-closed): el binding es evidencia de
          // ESTE ciclo de revisión, NO un hecho histórico. Al reenviar, el conductor corrigió su material
          // (DNI o selfie); el cotejo viejo apuntaba al material OBSOLETO. Si NO lo limpiáramos, el gate de
          // ejecución de approve() (`dniFaceMatchedAt != null`) PASARÍA con el timestamp del PRIMER cotejo
          // (contra el DNI viejo) → un re-approve ligaría material stale. Lo reseteamos a "no corrido" en la
          // MISMA escritura/tx que lleva el estado a PENDING: una re-aprobación OBLIGA a re-correr
          // matchDniFace() contra el material corregido (el gate de approve() vuelve a morder). Los 3 campos
          // del binding se setean juntos en matchDniFace() y se limpian juntos acá → coherencia atómica.
          dniFaceMatched: null,
          dniFaceMatchScore: null,
          dniFaceMatchedAt: null,
        },
      });
      await tx.user.update({
        where: { id: driver.userId },
        data: { kycStatus: KycStatus.PENDING },
      });
      // Emite driver.resubmitted por OUTBOX en la MISMA tx (igual que approve/reject): el admin-bff
      // proyecta status=PENDING en el read-model → el conductor reaparece como PENDIENTE (no stale en
      // REJECTED). Cierra el double-source entre la lista (read-model) y el detalle (identity en vivo).
      const envelope = createEnvelope({
        eventType: 'driver.resubmitted',
        producer: 'identity-service',
        payload: {
          driverId: driver.id,
          userId: driver.userId,
          resubmittedAt: new Date().toISOString(),
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
   * HARD PURGE de un conductor NO-OPERADO (re-registro) — NO es el soft-delete BR-S06 del sweeper.
   * Borra REALMENTE el agregado de identity en UNA transacción atómica: la fila Driver, y por su
   * `userId` todos sus métodos de auth, intentos biométricos, consentimientos, y FINALMENTE la fila User
   * (esto libera el teléfono `@unique` para que la persona pueda re-registrarse de cero).
   *
   * ORDEN del borrado (FK sin cascada cross-tabla salvo AuthMethod): primero Driver (FK → User sin
   * onDelete), luego los hijos por `userId` (auth_methods/biometric_checks/consents), y al final el User.
   * AuthMethod SÍ tiene onDelete: Cascade, pero lo borramos explícito igual para devolver un contador
   * honesto y no depender del orden de cascada de la DB.
   *
   * El guard de "no tiene historial operativo" (trips) vive AGUAS ARRIBA en el admin-bff (dueño del dato
   * de trips); aquí sólo se ejecuta el borrado de lo que ES de identity. Devuelve el `userId` liberado
   * para que el orquestador encadene fleet/media (que indexan por User.id, no por Driver.id).
   */
  async purge(driverId: string): Promise<DriverPurgeResult> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado', { driverId });
      const { userId } = driver;

      const deletedDriver = await tx.driver.delete({ where: { id: driverId } });
      const authMethods = await tx.authMethod.deleteMany({ where: { userId } });
      const biometricChecks = await tx.biometricCheck.deleteMany({ where: { userId } });
      const consents = await tx.consent.deleteMany({ where: { userId } });
      // Borra el User AL FINAL: libera el teléfono (@unique) para re-registro. delete (no deleteMany)
      // para fallar ruidosamente si por alguna razón no existe (invariante: todo Driver tiene User).
      await tx.user.delete({ where: { id: userId } });

      return {
        userId,
        deleted: {
          driver: deletedDriver ? 1 : 0,
          authMethods: authMethods.count,
          biometricChecks: biometricChecks.count,
          consents: consents.count,
          user: 1,
        },
      };
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
      // SOURCE DOCUMENT_EXPIRED: suspensión por documento crítico vencido. La reactivación manual del
      // operador NO puede levantarla (solo se levanta cuando el conductor regulariza sus documentos).
      data: { suspendedAt, suspensionSource: SuspensionSource.DOCUMENT_EXPIRED },
    });
    return result.count > 0;
  }

  /**
   * Enrolamiento KYC con UNA selfie, SIN prueba de vida (decisión Lote 1): el conductor manda una sola foto
   * y biometric-service `POST /v1/embed` deriva el embedding de referencia ArcFace (exige 1 rostro claro,
   * sin reto girar/asentir/sonreír). La defensa anti-suplantación ya NO vive acá (liveness), sino en el
   * face-match DNI↔selfie del binding (matchDniFace), que el operador VE antes de aprobar. Flujo:
   *   1. La app captura UNA selfie.
   *   2. POST /drivers/biometric/enroll con { photo } (base64 sin prefijo data:).
   *
   * Si el motor NO detecta un rostro (embedding vacío) → 422 tipado (UnprocessableEntityError, reason
   * 'no_face'): el enrolamiento se RECHAZA y no se guarda nada (fail-closed, degradación HONESTA, sin
   * embedding falso). Si hay rostro, persiste el embedding + `faceEnrolledAt` en UNA escritura — el gate
   * `hasFaceEmbedding` (aprobación del operador + inicio de turno) lo lee como fuente única de "enrolado".
   *
   * INVALIDA EL BINDING DNI↔selfie EN LA MISMA ESCRITURA (causa raíz, fail-closed · invariante de FRESCURA):
   * el binding (`dniFaceMatched`/`dniFaceMatchScore`/`dniFaceMatchedAt`, seteados juntos en matchDniFace())
   * es evidencia FRESCA contra el `faceEmbedding` con el que se cotejó — y SOLO contra ESE embedding. Re-enrolar
   * MUTA `faceEmbedding`: el cotejo viejo apunta ahora a un embedding OBSOLETO, así que el binding queda
   * INVÁLIDO. Si NO lo limpiáramos, un conductor PENDING con match ya corrido podría re-enrolar OTRA cara y el
   * gate de ejecución de approve() (`dniFaceMatchedAt != null`) PASARÍA con el timestamp del cotejo contra el
   * embedding VIEJO → aprobación con binding STALE (mismo agujero que ya cerró resubmit()). Por eso, en la MISMA
   * escritura que muta el embedding, RESETEAMOS los 3 campos del binding a "no corrido": cambiar el material
   * cotejado OBLIGA a re-correr matchDniFace() contra el embedding nuevo antes de poder aprobar (el gate de
   * approve() vuelve a morder). NO rompe el flujo normal (enrolar → match → approve): el reset deja
   * dniFaceMatchedAt=null y matchDniFace() lo vuelve a setear contra el embedding fresco.
   */
  async enrollFace(
    userId: string,
    input: { photo: string },
  ): Promise<{ enrolled: true; enrolledAt: string }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');

    const embedding = await this.biometric.embed(input.photo);

    // GATE DE ROSTRO (fail-closed): si el motor no detecta una cara, el embedding viene vacío → 422 tipado.
    // La app degrada HONESTO ("No detectamos tu rostro") y pide reintentar la selfie. Nunca un PASS inventado.
    if (!embedding.length) {
      throw new UnprocessableEntityError('No detectamos tu rostro', { reason: 'no_face' });
    }

    const enrolledAt = new Date();
    await this.prisma.write.driver.update({
      where: { id: d.id },
      data: {
        faceEmbedding: embedding,
        faceEnrolledAt: enrolledAt,
        // RESET DEL BINDING DNI↔selfie (invariante de frescura, mismo patrón que resubmit()): mutar el
        // embedding invalida el cotejo viejo (apuntaba al material anterior). Los 3 campos del binding se
        // limpian JUNTO al embedding nuevo → re-aprobar OBLIGA a re-correr matchDniFace() contra este material.
        dniFaceMatched: null,
        dniFaceMatchScore: null,
        dniFaceMatchedAt: null,
      },
    });
    return { enrolled: true, enrolledAt: enrolledAt.toISOString() };
  }

  /**
   * Sub-lote 3C · FACE-MATCH DNI↔selfie (BINDING). Corre el match entre la foto FRONT del DNI (que el
   * admin-bff baja de S3 y nos pasa como base64) y el `faceEmbedding` de referencia GUARDADO del conductor
   * (el que enroló con liveness), GUARDA el resultado y lo devuelve para que el operador lo VEA antes de
   * aprobar (no aprueba a ciegas).
   *
   * GARANTÍA DE SEGURIDAD (causa raíz del diseño): el match usa SIEMPRE el embedding GUARDADO del conductor
   * (leído de la DB, NUNCA uno que mande el caller) + la imagen del DNI REAL (bytes de S3 que el admin-bff
   * bajó del documento que el conductor subió, no una imagen arbitraria). El caller solo aporta la imagen del
   * DNI; la biometría de referencia es server-truth. Así el binding liga la cara del DNI con la biometría
   * enrolada, sin que un caller malicioso pueda inyectar un embedding que "coincida".
   *
   * Sin biometría enrolada → 409 tipado (ConflictError): no hay referencia contra la cual cotejar (mismo
   * predicado `hasFaceEmbedding` que el gate de aprobación y el de turno). El guardado va en UNA escritura
   * atómica (driver.update con los 3 campos del resultado) — el operador lee siempre un resultado coherente.
   */
  async matchDniFace(
    driverId: string,
    input: { image: string },
  ): Promise<BiometricDniMatchResult> {
    const driver = await this.prisma.read.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new NotFoundError('Conductor no encontrado', { driverId });
    // Gate: sin embedding de referencia enrolado NO hay match (no hay contra qué cotejar). 409 tipado,
    // mismo predicado que approve()/startShift() (fuente única de "biométricamente enrolado").
    if (!hasFaceEmbedding(driver)) {
      throw new ConflictError('El conductor no tiene biometría facial enrolada', { driverId });
    }

    // El match usa el embedding GUARDADO (server-truth, NO uno del caller) + la imagen del DNI REAL (S3).
    const result = await this.biometric.matchDniFace({
      image: input.image,
      referenceEmbedding: driver.faceEmbedding,
    });

    // GUARDA el resultado en UNA escritura atómica: el operador siempre lee un binding coherente
    // (veredicto + score + momento juntos). El score se persiste CRUDO (decimal) tal como lo devuelve el motor
    // — `dniFaceMatchScore` es Float? en el schema, escala 0..100. (A diferencia de verifyBiometric, que SÍ
    // redondea a entero porque su score viaja en un sessionRef de un solo uso; acá el operador lo VE y el gate
    // de approve() mira `dniFaceMatchedAt`, no el score, así que no se redondea.)
    await this.prisma.write.driver.update({
      where: { id: driverId },
      data: {
        dniFaceMatched: result.matched,
        dniFaceMatchScore: result.score,
        dniFaceMatchedAt: new Date(),
      },
    });

    return result;
  }

  /**
   * Emite un reto de liveness activo para el ENROLAMIENTO del conductor (BR-I02). Mismo contrato que el
   * reto de turno (createBiometricChallenge): reusa el puerto `createChallenge()`. Se separa por endpoint
   * (GET /drivers/me/biometric/liveness/challenge) porque es un paso del onboarding, no del turno.
   */
  async createEnrollChallenge(userId: string): Promise<BiometricChallenge> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');
    return this.biometric.createChallenge();
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
    if (!hasFaceEmbedding(d)) {
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
    // GATE BIOMÉTRICO en el CHOKE POINT OPERATIVO (TOCTOU fix): la invariante "CLEARED ⟹ tiene embedding"
    // NO se sostiene sola — el sweeper de borrado (BR-S06) vacía `faceEmbedding` SIN tocar
    // `backgroundCheckStatus`, así que un conductor CLEARED puede quedarse sin biometría de referencia. Por
    // eso re-validamos el enrolamiento AQUÍ, igual que `approve()` (mismo `hasFaceEmbedding`). Este es el gate
    // BARATO de fail-fast sobre la réplica; la AUTORIDAD final es el CAS atómico de abajo (`isEmpty: false` en
    // el where), que cierra la ventana de carrera contra un borrado concurrente sobre el dato FRESCO.
    if (!hasFaceEmbedding(d)) throw new ConflictError('Biometría facial no enrolada');

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

    // #2 + #10 + TOCTOU biométrico — TRANSICIÓN POR CAS ATÓMICO: el estado fuente válido (derivado de la
    // máquina, cero strings mágicos), `suspendedAt: null` Y `faceEmbedding` no vacío (`isEmpty: false`)
    // viajan en el WHERE — TODO sobre el dato FRESCO, no la réplica. Dos startShift concurrentes: solo UNO
    // matchea (el otro ve count=0 → carrera). Y si un borrado (sweeper) vació el embedding entre la réplica
    // y la tx, el `isEmpty: false` hace que NO matchee (count 0) → fail-closed, sin biometría no hay turno.
    await this.prisma.write.$transaction(async (tx) => {
      const claim = await tx.driver.updateMany({
        where: {
          id: d.id,
          suspendedAt: null,
          faceEmbedding: { isEmpty: false },
          currentStatus: { in: driverStatusSources(DriverStatus.AVAILABLE) },
        },
        data: { currentStatus: DriverStatus.AVAILABLE, lastVerifiedAt: new Date() },
      });
      if (claim.count === 0) {
        // Releemos para un error HONESTO con el estado real (la auditoría del intento YA quedó persistida).
        const current = await tx.driver.findUnique({
          where: { id: d.id },
          select: { currentStatus: true, suspendedAt: true, faceEmbedding: true },
        });
        if (!current) throw new NotFoundError('Conductor no encontrado');
        if (current.suspendedAt) throw new ForbiddenError('Conductor suspendido');
        // Biometría borrada bajo nuestros pies (sweeper concurrente): error tipado claro, no un falso "carrera".
        if (!hasFaceEmbedding(current)) throw new ConflictError('Biometría facial no enrolada');
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
    // PII Ley 29733: el DNI se persiste CIFRADO en reposo (AES-256-GCM · secret-box), nunca en claro. Es
    // cifrado REVERSIBLE (no hash) porque compliance debe MOSTRARLO al operador para verificación manual:
    // identity descifra en el borde gRPC (toDriverReply) antes de mandarlo al admin-bff (gateado Compliance+).
    const documentIdEnc = seal(input.dni, this.dniEncKey);
    await this.prisma.write.driver.upsert({
      where: { userId },
      create: {
        userId,
        currentStatus: DriverStatus.OFFLINE,
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
        legalName: input.legalName,
        documentIdEnc,
        birthDate,
      },
      update: {
        legalName: input.legalName,
        documentIdEnc,
        birthDate,
      },
    });
    // La vista vuelve al PROPIO conductor (que ya tipeó el DNI): se devuelve ENMASCARADO (últimos 4 dígitos),
    // nunca el crudo ni el ciphertext. Se arma desde el input plano (no se re-descifra de la fila escrita).
    return {
      legalName: input.legalName,
      dni: maskDniForOwner(input.dni),
      birthDate: input.birthDate,
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
