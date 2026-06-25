/**
 * DriversService — onboarding autoservicio + aprobación del operador, y el gate biométrico de turno.
 * BR-I01/I02: sin KYC aprobado no hay turno; liveness+match score >= mínimo; 3 fallos → bloqueo 1h.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
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
  type Driver,
  DriverStatus,
  KycStatus,
  Prisma,
  SuspensionCause,
} from '../generated/prisma';
import { backgroundCheckMachine, isBackgroundCleared } from '../domain/background-check';
import { hasFaceEmbedding } from '../domain/face-embedding';
import { driverStatusMachine, type SelfServiceDriverStatus } from '../domain/driver-status';
import { kycStatusMachine } from '../domain/kyc-status';
import type { Env } from '../config/env.schema';

const MAX_BIO_FAILS = 3;
const BIO_LOCK_TTL_SECONDS = 3600; // 1h (BR-I02)
/**
 * Motivos TIPADOS del rechazo del enrol KYC del alta (contrato con la app: viajan en `details.reason` del 422
 * y `kycEnrollError` los lee para elegir el banner). Constantes, NO strings sueltos (ARQUITECTURA §4-ter): un
 * typo es error de compilación. `spoof` además se AUDITA (`biometric.enroll_rejected`, traza forense Ley
 * 29733); `no_face` es ruido operativo (no se detectó persona → reintentar), no se audita.
 */
const ENROLL_REJECT_SPOOF = 'spoof';
const ENROLL_REJECT_NO_FACE = 'no_face';
/**
 * Techo de abuso del ENROL del alta (anti-hammering del PAD): tras N rechazos por SPOOF seguidos, cooldown
 * temporal. A PROPÓSITO más laxo y CORTO que el lockout del turno (5 spoofs / 15 min, no 3 / 1h): el enrol es
 * onboarding y el PAD tiene falsos positivos (luz/cámara) — un cooldown corto corta el scripting/fraude SIN
 * atrapar 1h a un conductor legítimo. Solo `spoof` suma (no `no_face`, que es ruido operativo). Se limpia al
 * enrolar OK; la central puede destrabar antes (unlock admin). El intento queda auditado (biometric.enroll_rejected).
 */
const MAX_ENROLL_SPOOFS = 5;
const ENROLL_SPOOF_LOCK_TTL_SECONDS = 900; // 15 min
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

/** Clave Redis del lockout de fallos biométricos del conductor (gate de TURNO). */
function bioLockKey(driverId: string): string {
  return `veo:bio:fails:${driverId}`;
}

/** Clave Redis del cooldown de abuso por SPOOF del ENROL del alta (anti-hammering del PAD). */
function enrollSpoofLockKey(driverId: string): string {
  return `veo:bio:enroll-spoof:${driverId}`;
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
  /** Observabilidad (F4): logs estructurados del flujo biométrico (enrol/turno/lockout/destrabe) — SRE/central
   *  veían un agujero ciego. Los WARN de lockout/spoof/degradado son alertables (rate por log). */
  private readonly logger = new Logger(DriversService.name);
  private readonly minScore: number;
  /** Clave de cifrado del DNI del conductor en reposo (AES-256-GCM · secret-box). KMS en prod. */
  private readonly dniEncKey: string;
  /** Cooldown (ms) del hold TEMPORAL EXCESSIVE_CANCELLATIONS (auto-suspensión por exceso de cancelaciones). */
  private readonly cancellationCooldownMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BIOMETRIC_PROVIDER) private readonly biometric: BiometricProvider,
    config: ConfigService<Env, true>,
  ) {
    this.minScore = config.getOrThrow<number>('BIOMETRIC_MIN_SCORE');
    this.dniEncKey = config.getOrThrow<string>('DRIVER_DNI_ENC_KEY');
    this.cancellationCooldownMs =
      config.getOrThrow<number>('EXCESSIVE_CANCELLATION_COOLDOWN_HOURS') * 60 * 60 * 1000;
  }

  /**
   * Materializa el cascarón del agregado Driver de forma idempotente y ORDEN-INDEPENDIENTE, emitiendo
   * `driver.registered` por OUTBOX EXACTAMENTE UNA VEZ (solo quien GANA la creación de la fila). El alta es un
   * wizard de dos pasos (datos personales / licencia) que pueden llegar en CUALQUIER orden, y ambos pasan por
   * acá. Primitiva atómica: `createMany({ skipDuplicates })` = `INSERT ... ON CONFLICT DO NOTHING`, que devuelve
   * `count`:
   *   - count === 1 ⇒ ESTA llamada creó la fila ⇒ emite el evento en la MISMA tx (outbox-in-tx · FOUNDATION §6);
   *   - count === 0 ⇒ la fila ya existía (el OTRO paso del wizard ya la creó y ya emitió) ⇒ solo actualiza su slice.
   * Sin check-then-act (la unicidad de `userId` la garantiza Postgres) y sin abortar la tx (ON CONFLICT DO NOTHING
   * NO lanza, a diferencia de un create + catch P2002 que deja la tx en estado fallido): exactly-once aún con
   * doble-tap CONCURRENTE del mismo conductor. Mismo idioma de "el count discrimina al ganador" que usa `approve()`
   * con su `updateMany`. Downstream: admin-bff proyecta status=PENDING en el read-model → el conductor aparece en la
   * vista de FLOTA ("Todos") desde el alta, no recién cuando hay una decisión.
   */
  private materializeDriverShell(
    userId: string,
    createData: Prisma.DriverCreateManyInput,
    updateData: Prisma.DriverUpdateInput,
  ): Promise<Driver> {
    return this.prisma.write.$transaction(async (tx) => {
      const inserted = await tx.driver.createMany({ data: createData, skipDuplicates: true });
      const created = inserted.count === 1;
      if (!created) {
        await tx.driver.update({ where: { userId }, data: updateData });
      }
      const driver = await tx.driver.findUniqueOrThrow({ where: { userId } });
      if (created) {
        const envelope = createEnvelope({
          eventType: 'driver.registered',
          producer: 'identity-service',
          payload: { driverId: driver.id, userId, registeredAt: new Date().toISOString() },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: driver.id,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return driver;
    });
  }

  /**
   * Onboarding del conductor (User type DRIVER): registra su licencia y queda PENDING de aprobación.
   *
   * IDEMPOTENTE Y ORDEN-INDEPENDIENTE (fix P0): el alta del conductor es un wizard multi-paso (datos
   * personales, licencia, biometría) que NO tiene un único "paso creador". Cualquier paso que corra
   * primero materializa el agregado Driver; los demás actualizan su slice. La materialización + el
   * `driver.registered` exactly-once viven en `materializeDriverShell` (ver su doc): crea la fila-cascarón
   * con los defaults del agregado + la licencia si aún no existe, o solo actualiza la licencia si ya existía
   * (porque corrió antes `updatePersonalInfo`). Reentrante por diseño: reenviar la licencia NO lanza
   * ConflictError. El hecho "listo para revisión" sigue representándose con backgroundCheckStatus PENDING
   * (lo que consulta `listPendingApproval`), pero AHORA además se proyecta a la flota vía `driver.registered`.
   */
  async onboard(
    userId: string,
    input: { licenseNumber: string; licenseExpiresAt: string },
  ): Promise<{ driverId: string; backgroundCheckStatus: string }> {
    const user = await this.prisma.read.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    if (user.type !== 'DRIVER') throw new ForbiddenError('El usuario no es conductor');

    const licenseExpiresAt = new Date(input.licenseExpiresAt);
    const driver = await this.materializeDriverShell(
      userId,
      {
        userId,
        licenseNumber: input.licenseNumber,
        licenseExpiresAt,
        currentStatus: DriverStatus.OFFLINE,
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
      },
      {
        licenseNumber: input.licenseNumber,
        licenseExpiresAt,
      },
    );
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
      // GATE DE EJECUCIÓN DEL BINDING LICENCIA↔selfie (Lote C · binding MÁS FUERTE, fail-closed): gemelo del
      // gate del DNI. `licenseFaceMatchedAt == null` ⇔ matchLicenseFace() nunca corrió. Es gate de EJECUCIÓN,
      // NO de veredicto: un licenseFaceMatched===false (NO_MATCH, frecuente por la baja resolución del brevete)
      // SÍ pasa — el operador lo vio y decide. Curl-proof: no se aprueba sin haber corrido AMBOS cotejos.
      if (driver.licenseFaceMatchedAt == null) {
        throw new ConflictError(
          'No se puede aprobar: el face-match licencia↔selfie no se ejecutó. Corré el cotejo antes de aprobar.',
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
          // Mismo gate ATÓMICO para la licencia (Lote C): si un resubmit()/enrollFace() concurrente nulifica
          // el binding del brevete entre el pre-read y este CAS, la fila ya NO matchea → count 0 → no se aprueba.
          licenseFaceMatchedAt: { not: null },
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
   * RECOMPUTA `Driver.suspendedAt` (campo DERIVADO/mantenido) a partir del CONJUNTO de holds vigentes, DENTRO
   * de la tx que acaba de agregar/quitar un hold. Es el corazón del modelo de HOLDS: la suspensión NO es un
   * flag, es "tiene ≥1 hold". `suspendedAt` se conserva SOLO para que los lectores externos (startShift, el
   * eligibility gate de dispatch/booking vía gRPC `toDriverReply.suspendedAt`, el badge admin-bff) no cambien
   * — ninguno lee los holds, todos leen este campo.
   *
   * INVARIANTE que mantiene (atómica con el add/remove, misma tx): `suspendedAt != null` ⟺ ≥1 hold; `null` ⟺ 0.
   *   - Si quedan holds: `suspendedAt` = createdAt del PRIMER hold (el más viejo). Así regularizar UNA causa de
   *     varias NO mueve el momento original de la suspensión (no "rejuvenece" el timestamp). Si ya estaba seteado
   *     al mismo valor, el update es idempotente (no cambia nada).
   *   - Si NO quedan holds: `suspendedAt` = null → el conductor queda LIBRE (el CAS de startShift vuelve a pasar).
   *
   * @returns el `suspendedAt` resultante (Date si quedó suspendido, null si quedó libre).
   */
  private async recomputeSuspendedAt(
    tx: Prisma.TransactionClient,
    driverId: string,
  ): Promise<Date | null> {
    // El PRIMER hold (más viejo) fija el momento original de la suspensión. findFirst orderBy asc → 0..1 fila.
    const oldest = await tx.driverSuspensionHold.findFirst({
      where: { driverId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const suspendedAt = oldest?.createdAt ?? null;
    // Update directo del campo derivado (dentro de la tx del add/remove): idempotente si ya tenía ese valor.
    await tx.driver.update({ where: { id: driverId }, data: { suspendedAt } });
    return suspendedAt;
  }

  /**
   * AGREGA un hold (idempotente por el `@@unique([driverId, cause, causeRef])`) y recomputa `suspendedAt`,
   * todo DENTRO de `tx`. Reúne el patrón de las 3 vías de suspensión (operador, documento, ITV).
   *
   * IDEMPOTENCIA (re-suspender la MISMA causa = no-op): `upsert` sobre el natural key. Si el hold YA existía,
   * el `update` es vacío (no toca `createdAt`: preserva el momento original) → 0→1 no ocurrió, no es "nuevo".
   * Distingue "se creó un hold nuevo" de "ya existía" leyendo si HABÍA holds antes: si el conductor pasa de
   * 0→≥1 holds, ES una suspensión nueva (emite evento aguas arriba); si ya tenía holds o ya tenía ESTE, no.
   *
   * @returns `{ created, suspendedAt }` — `created=true` SOLO si este hold no existía antes (para que el caller
   *   decida si emitir el evento de dominio; un re-suspender idempotente NO re-emite).
   */
  private addHold(
    tx: Prisma.TransactionClient,
    driverId: string,
    cause: SuspensionCause,
    causeRef: string,
    reason: string,
    expiresAt?: Date,
  ): Promise<{ created: boolean; suspendedAt: Date }> {
    // El operador suspende AHORA: createdAt = now (default del hold). Las vías de fleet usan addHoldAt con
    // el momento que fleet reportó (preservan el origen). Mismo idempotency/recompute, distinto createdAt.
    // `expiresAt` (opcional): hold TEMPORAL (cooldown auto-expirable, hoy EXCESSIVE_CANCELLATIONS); undefined =
    // hold PERMANENTE (el comportamiento de todas las causas previas, columna NULL).
    return this.addHoldAt(tx, driverId, cause, causeRef, reason, new Date(), expiresAt);
  }

  /**
   * Variante de `addHold` con `createdAt` EXPLÍCITO: las suspensiones de fleet (documento/ITV) llevan el
   * momento que fleet reportó (`suspendedAt` del evento), no `now`. Así `Driver.suspendedAt` derivado refleja
   * el momento REAL del vencimiento, no el de la recepción del evento. Mismo natural key e idempotencia.
   *
   * `expiresAt` (opcional): VENCIMIENTO del hold TEMPORAL (primer hold con expiración del sistema). undefined →
   * columna NULL → hold PERMANENTE (todas las causas previas). Seteado → cooldown auto-expirable que el sweeper
   * levanta al vencer.
   */
  private async addHoldAt(
    tx: Prisma.TransactionClient,
    driverId: string,
    cause: SuspensionCause,
    causeRef: string,
    reason: string,
    createdAt: Date,
    expiresAt?: Date,
  ): Promise<{ created: boolean; suspendedAt: Date }> {
    // ¿Existía YA este hold exacto? (natural key). Si sí, el upsert es no-op y NO es una suspensión nueva.
    const existing = await tx.driverSuspensionHold.findUnique({
      where: { driverId_cause_causeRef: { driverId, cause, causeRef } },
      select: { id: true },
    });
    await tx.driverSuspensionHold.upsert({
      where: { driverId_cause_causeRef: { driverId, cause, causeRef } },
      // create lleva el reason + createdAt + expiresAt frescos; update VACÍO → preserva createdAt + reason +
      // expiresAt originales (idempotente). IDEMPOTENCIA DEL COOLDOWN (CRÍTICO): el `update: {}` significa que
      // una RE-ENTREGA de Kafka (mismo cruce) NO extiende `expiresAt` — el cooldown NO se alarga con redeliveries.
      // Un cruce REAL nuevo SIEMPRE es un `create` fresco (el sweeper ya removió el hold viejo al vencer), así que
      // ese sí estampa un expiresAt nuevo. NO-extender-en-conflicto es la regla que protege el cooldown.
      create: { driverId, cause, causeRef, reason, createdAt, expiresAt },
      update: {},
    });
    const suspendedAt = await this.recomputeSuspendedAt(tx, driverId);
    // suspendedAt NUNCA es null acá (acabamos de garantizar ≥1 hold) — el cast es seguro por construcción.
    return { created: existing === null, suspendedAt: suspendedAt as Date };
  }

  /**
   * QUITA los holds que matcheen `where` (idempotente: borrar 0 holds = no-op) y recomputa `suspendedAt`,
   * todo DENTRO de `tx`. Reúne el patrón de las 4 vías de reactivación. NUNCA toca holds de OTRA causa: el
   * `where` acota EXACTAMENTE las causas que esta vía puede levantar (la separación de causas se respeta).
   *
   * @returns `{ removed, suspendedAt }` — `removed` = cuántos holds se quitaron (0 = no-op); `suspendedAt` = el
   *   estado DERIVADO tras quitarlos (Date si quedan otros holds → SIGUE suspendido; null → quedó LIBRE).
   */
  private async removeHolds(
    tx: Prisma.TransactionClient,
    driverId: string,
    where: Prisma.DriverSuspensionHoldWhereInput,
  ): Promise<{ removed: number; suspendedAt: Date | null }> {
    const deleted = await tx.driverSuspensionHold.deleteMany({ where: { driverId, ...where } });
    const suspendedAt = await this.recomputeSuspendedAt(tx, driverId);
    return { removed: deleted.count, suspendedAt };
  }

  /**
   * Suspensión MANUAL del conductor por un operador admin (acción de SAFETY, espejo de reject). Bajo el modelo
   * de HOLDS: agrega un hold DISCIPLINARY y recomputa `Driver.suspendedAt` —el MISMO campo que el gate de inicio
   * de turno (startShift) y el eligibility gate de dispatch leen para bloquear (BR-I02)—, así un conductor con
   * ≥1 hold NO puede iniciar turno ni aceptar ofertas (enforcement ya existente, fail-closed). Emite
   * `driver.suspended` por OUTBOX en la MISMA tx para que audit/admin-bff reaccionen (igual que reject).
   *
   * IDEMPOTENTE por el `@@unique` del hold (espeja el CAS viejo): re-suspender disciplinariamente a un conductor
   * que YA tiene un hold DISCIPLINARY es un upsert no-op → NO reescribe el momento NI re-emite el evento. El hold
   * DISCIPLINARY usa `causeRef = ''` (una sola instancia: el operador no "acumula" disciplinarias). El `reason`
   * SÍ se persiste ahora (en el hold) además de viajar al evento + al audit del admin-bff.
   *
   * NO toca holds de documento/ITV: si el conductor también tenía un DOCUMENT_EXPIRED, ese hold sigue (la
   * suspensión es el conjunto). Levantar ESTE hold disciplinario va por reactivate() (que NO toca los otros).
   */
  async suspend(driverId: string, reason: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      const { created, suspendedAt } = await this.addHold(
        tx,
        driverId,
        SuspensionCause.DISCIPLINARY,
        '',
        reason,
      );
      // Idempotente: el hold DISCIPLINARY ya existía → no es una suspensión nueva, no se re-emite el evento.
      if (!created) return;
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
   * REACTIVACIÓN MANUAL del conductor por un operador admin (la inversa de suspend(), acción de SAFETY). Bajo
   * el modelo de HOLDS: QUITA SOLO el hold DISCIPLINARY y recomputa `Driver.suspendedAt`. NUNCA toca holds de
   * documento (DOCUMENT_EXPIRED) ni de ITV (INSPECTION_EXPIRED) — re-habilitar a un conductor con SOAT/licencia/
   * ITV vencida es un bug de seguridad inaceptable. Si tras quitar el hold disciplinario QUEDAN holds de doc/ITV,
   * el conductor SIGUE suspendido (`suspendedAt` recomputado sigue seteado). Emite `driver.reactivated` por
   * OUTBOX en la MISMA tx (igual que suspend) — admin-bff/audit reaccionan.
   *
   * Esto arregla la CRÍTICA de RAÍZ junto con su par reactivateForCompliance: cada vía levanta SOLO SUS holds;
   * el conductor se libera de verdad SOLO cuando llega a 0 holds.
   *
   * SEMÁNTICA (en orden):
   *   1. Carga el driver en la tx; 404 si no existe.
   *   2. Si NO tiene hold DISCIPLINARY → error honesto (no estaba suspendido disciplinariamente). 409 si no tiene
   *      NINGÚN hold (nada que reactivar); 403 si está suspendido pero por OTRA causa (doc/ITV, va por compliance).
   *   3. Re-valida eligibility mínima: licencia vencida → 403. (El gate operativo COMPLETO —biometría, KYC— lo
   *      sigue imponiendo startShift BR-I02; reactivar NO devuelve al conductor a AVAILABLE ni toca currentStatus.)
   *   4. Quita el hold DISCIPLINARY (idempotente) y recomputa suspendedAt. Si removed===0, releemos para error honesto.
   *   5. Emite driver.reactivated por OUTBOX (misma tx).
   */
  async reactivate(driverId: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      // 2) FAIL-CLOSED por CAUSA: el operador solo revierte el hold DISCIPLINARY que él originó. Distinguimos
      //    "no está suspendido" (409, nada que reactivar) de "suspendido pero NO disciplinariamente" (403:
      //    es doc/ITV, se levanta cuando regulariza / por la vía de compliance). Se lee el hold DISCIPLINARY:
      //    su ausencia es la condición honesta para el error (no inferimos del flag colapsado, ya no existe).
      const disciplinary = await tx.driverSuspensionHold.findUnique({
        where: {
          driverId_cause_causeRef: { driverId, cause: SuspensionCause.DISCIPLINARY, causeRef: '' },
        },
        select: { id: true },
      });
      if (!disciplinary) {
        if (driver.suspendedAt === null) {
          throw new ConflictError('El conductor no está suspendido');
        }
        throw new ForbiddenError(
          'No se puede reactivar: la suspensión es por documentos/ITV vencidos; se levanta cuando el conductor regulariza',
        );
      }
      // 3) Re-validación mínima de eligibility: NO reactivamos sobre una licencia vencida. El gate operativo
      //    completo (biometría, KYC) lo sigue imponiendo startShift (BR-I02).
      if (driver.licenseExpiresAt && driver.licenseExpiresAt.getTime() < Date.now()) {
        throw new ForbiddenError('No se puede reactivar: la licencia está vencida');
      }
      // 4) Quita SOLO el hold DISCIPLINARY (NUNCA doc/ITV) y recomputa suspendedAt. Si removed===0, otra tx
      //    ya lo quitó (carrera) → releemos para un error HONESTO. Si quedan holds de doc/ITV, suspendedAt
      //    recomputado SIGUE seteado: el conductor permanece suspendido (la CRÍTICA, resuelta de raíz).
      const { removed } = await this.removeHolds(tx, driverId, {
        cause: SuspensionCause.DISCIPLINARY,
        causeRef: '',
      });
      if (removed === 0) {
        // El hold existía en el pre-read pero ya no: una reactivación concurrente lo quitó. Error honesto.
        throw new ConflictError('El conductor ya fue reactivado');
      }
      // 5) Emite driver.reactivated por OUTBOX en la MISMA tx (igual que suspend): admin-bff proyecta el
      //    status de SUSPENDED de vuelta a ACTIVE; audit deja la traza inmutable de la decisión. (El evento se
      //    emite porque se levantó EL hold disciplinario, aunque el conductor siga suspendido por otra causa:
      //    el hecho de dominio "se revirtió la disciplinaria" ocurrió; admin-bff reconcilia el status real.)
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
   * OVERRIDE MANUAL del operador para una suspensión AUTOMÁTICA (NO-disciplinaria · decisión del dueño ·
   * compliance/seguridad). Es el HERMANO de `reactivate()`: aquella levanta SOLO DISCIPLINARY (suspensiones que
   * el operador originó); ésta levanta TODO hold cuya `cause !== DISCIPLINARY` — hoy DOCUMENT_EXPIRED,
   * INSPECTION_EXPIRED y RATING_LOW (auto-suspensión por rating bajo), y CUALQUIER causa automática futura sin
   * tocar este método. La separación de fuentes se RESPETA extremo-a-extremo: cada vía levanta su propio conjunto
   * y NUNCA el del otro (un DISCIPLINARY por esta vía → 403; un hold automático por `reactivate()` → 403). Así el
   * operador regulariza a mano (override) sin que se mezclen los dos flujos de safety.
   *
   * Por qué un método separado y no un flag en reactivate(): el AUDIT del admin-bff distingue la acción
   * (`driver.reactivate` vs `driver.reactivate-compliance`), el evento de dominio es el mismo
   * (`driver.reactivated`) y las CAUSAS que levanta son DISTINTAS (esta levanta TODO lo NO-disciplinario;
   * reactivate() levanta SOLO DISCIPLINARY). El latch de ITV vive en fleet (otro servicio): lo limpia el
   * ORQUESTADOR (admin-bff) tras este levantamiento, NO identity (regla 2: no cruzar tablas).
   *
   * GENERALIZACIÓN (decisión del dueño): RATING_LOW es una causa automática nueva cuya reactivación es MANUAL
   * (no se auto-levanta al recuperar el rating). En vez de enumerar causas (y olvidar agregar las futuras), esta
   * vía levanta el COMPLEMENTO de DISCIPLINARY → RATING_LOW y cualquier causa automática futura entran solas.
   *
   * SEMÁNTICA (espeja reactivate(), modelo de HOLDS):
   *   1. 404 si el conductor no existe.
   *   2. 409 si NO está suspendido (0 holds, nada que reactivar).
   *   3. 403 si NO tiene ningún hold NO-disciplinario (solo DISCIPLINARY → va por reactivate()).
   *   4. 403 si la licencia está vencida (no reactivamos sobre una licencia vencida; el gate operativo COMPLETO
   *      —biometría, KYC— lo sigue imponiendo startShift BR-I02).
   *   5. Quita TODO hold NO-DISCIPLINARY (NUNCA DISCIPLINARY) y recomputa suspendedAt. Si tras quitarlos QUEDA un
   *      hold DISCIPLINARY, el conductor SIGUE suspendido (la separación de causas).
   *   6. Emite driver.reactivated por OUTBOX (misma tx).
   */
  async reactivateForCompliance(driverId: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundError('Conductor no encontrado');
      if (driver.suspendedAt === null) {
        throw new ConflictError('El conductor no está suspendido');
      }
      // FAIL-CLOSED por CAUSA (inverso de reactivate()): esta vía levanta SOLO holds NO-disciplinarios (el
      // COMPLEMENTO de DISCIPLINARY: documento, ITV, rating, y futuros). Si el conductor NO tiene ninguno (está
      // suspendido solo por DISCIPLINARY) → 403 (se levanta por reactivate()). El conteo se hace ANTES de validar
      // la licencia para dar el error correcto (no pedir licencia vigente para algo que no es de compliance).
      const complianceHolds = await tx.driverSuspensionHold.count({
        where: {
          driverId,
          cause: { not: SuspensionCause.DISCIPLINARY },
        },
      });
      if (complianceHolds === 0) {
        throw new ForbiddenError(
          'No se puede reactivar por compliance: la suspensión no es de origen automático (documentos/ITV/rating)',
        );
      }
      // Re-validación mínima de eligibility: no reactivamos sobre una licencia vencida (mismo criterio que
      // reactivate()). El gate operativo completo (biometría, KYC) lo sigue imponiendo startShift (BR-I02).
      if (driver.licenseExpiresAt && driver.licenseExpiresAt.getTime() < Date.now()) {
        throw new ForbiddenError('No se puede reactivar: la licencia está vencida');
      }
      // Quita TODO hold NO-disciplinario (NUNCA DISCIPLINARY) y recomputa suspendedAt. Si tras quitarlos queda
      // un hold DISCIPLINARY, suspendedAt recomputado SIGUE seteado → el conductor permanece suspendido.
      const { removed } = await this.removeHolds(tx, driverId, {
        cause: { not: SuspensionCause.DISCIPLINARY },
      });
      if (removed === 0) {
        // Existían en el pre-count pero ya no: una carrera (otra reactivación/regularización) los quitó.
        throw new ConflictError('El conductor ya fue reactivado');
      }
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
   * SWEEPER de holds TEMPORALES vencidos (mecanismo nuevo · primer hold con expiración del sistema). Lo invoca el
   * @Cron de `HoldExpirySweeper`. Levanta los holds cuyo `expiresAt < now` (hoy EXCESSIVE_CANCELLATIONS) y recomputa
   * `Driver.suspendedAt` derivado por cada conductor afectado. NUNCA toca holds PERMANENTES (`expiresAt = null`:
   * DISCIPLINARY/DOCUMENT_EXPIRED/INSPECTION_EXPIRED/RATING_LOW) — el `where` exige `expiresAt != null AND < now`.
   *
   * BATCH (no N+1): UNA query lee TODOS los holds vencidos, se agrupan por driver en memoria, y se recomputa por
   * driver afectado (una tx por driver, igual que cada vía de reactivación). Idempotente: si un hold ya fue removido
   * (otra réplica / re-corrida), el deleteMany cuenta 0 → no se emite el evento (no hay reactivación nueva).
   *
   * Si un driver queda con 0 holds tras quitar los vencidos, emite `driver.reactivated` (MISMO evento/patrón que
   * reactivateForCompliance, outbox-in-tx) → admin-bff reconcilia el badge, audit deja la traza. Si quedan otros
   * holds (p.ej. una DISCIPLINARY), NO se emite (el conductor sigue suspendido — separación de causas).
   *
   * POR QUÉ sweeper y NO expiración LAZY: `suspendedAt` es la columna derivada ÚNICA que leen startShift/dispatch/
   * booking/admin; una expiración perezosa la dejaría STALE (el conductor seguiría bloqueado hasta la próxima
   * escritura). El sweeper mantiene la verdad derivada; el lag de minutos sobre un cooldown de horas es despreciable.
   *
   * RESIDUAL CONOCIDO (no resuelto aquí, mismo que el expiry-sweeper de fleet): @Cron SIN lock distribuido → en
   * multi-réplica corren N sweeps en paralelo. Es IDEMPOTENTE (deleteMany + recompute), así que NO corrompe estado:
   * a lo sumo dos réplicas intentan el mismo deleteMany (una gana, la otra cuenta 0) → trabajo duplicado, no daño.
   *
   * @returns cuántos conductores fueron efectivamente reactivados (quedaron con 0 holds). Público para test/operación.
   */
  async sweepExpiredHolds(now = new Date()): Promise<number> {
    // UNA query: todos los holds temporales vencidos (expiresAt NO null Y < now). Los permanentes (null) quedan fuera.
    const expired = await this.prisma.read.driverSuspensionHold.findMany({
      where: { expiresAt: { not: null, lt: now } },
      select: { driverId: true },
    });
    if (expired.length === 0) return 0;
    // Agrupa por driver en memoria (un set de driverIds afectados) → recompute por driver, no por hold (no N+1).
    const driverIds = [...new Set(expired.map((h) => h.driverId))];
    let reactivated = 0;
    for (const driverId of driverIds) {
      if (await this.expireHoldsForDriver(driverId, now)) reactivated += 1;
    }
    return reactivated;
  }

  /**
   * Quita los holds TEMPORALES vencidos de UN conductor en UNA tx, recomputa `suspendedAt` y —si quedó con 0 holds—
   * emite `driver.reactivated` (outbox-in-tx). Idempotente: si otra réplica ya los quitó, removeHolds cuenta 0 y NO
   * emite. NUNCA toca permanentes (el `where` exige `expiresAt != null AND < now`). Devuelve `true` si reactivó.
   */
  private async expireHoldsForDriver(driverId: string, now: Date): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      // Quita SOLO los holds temporales vencidos de este driver (expiresAt no-null Y < now). recomputa suspendedAt:
      // si quedan OTROS holds (permanentes u otro temporal aún vigente) → suspendedAt sigue seteado (sigue suspendido).
      const { removed, suspendedAt } = await this.removeHolds(tx, driverId, {
        expiresAt: { not: null, lt: now },
      });
      // Idempotencia: otra réplica/corrida ya los quitó → nada que reactivar, no se emite evento.
      if (removed === 0) return false;
      // Solo emitimos driver.reactivated si el conductor quedó LIBRE (0 holds → suspendedAt null). Si quedan otras
      // causas (DISCIPLINARY, etc.) SIGUE suspendido: el cooldown venció pero la otra causa lo mantiene (separación).
      if (suspendedAt !== null) return false;
      const envelope = createEnvelope({
        eventType: 'driver.reactivated',
        producer: 'identity-service',
        payload: {
          driverId,
          reactivatedAt: now.toISOString(),
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: driverId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
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
          // Mismo razonamiento para el binding licencia↔selfie (Lote C): el brevete viejo apuntaba al material
          // obsoleto. Se limpia junto al DNI → un re-approve OBLIGA a re-correr AMBOS cotejos contra lo corregido.
          licenseFaceMatched: null,
          licenseFaceMatchScore: null,
          licenseFaceMatchedAt: null,
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
   * Suspende un conductor por orden de fleet-service (documento crítico vencido → `fleet.driver_suspended`).
   * Bajo el modelo de HOLDS: agrega un hold DOCUMENT_EXPIRED con `causeRef = documentType` (SOAT/LICENSE_A1/
   * PROPERTY_CARD) — UN hold POR documento distinto, así regularizar el SOAT NO quita la licencia (la CRÍTICA).
   * Recomputa `Driver.suspendedAt`, que es lo que el gate de turno (startShift) lee para bloquear (BR-I02).
   *
   * IDEMPOTENTE por el `@@unique([driverId, cause, causeRef])`: re-entregas del MISMO evento (mismo documento) →
   * upsert no-op, NO reescribe el momento. El `suspendedAt` que aporta esta suspensión = createdAt de su hold
   * (preservado si ya existía). Si el conductor no existe localmente, se ignora silenciosamente (el evento puede
   * llegar antes que el onboarding): la FK del hold fallaría, así que comprobamos existencia primero.
   *
   * @param suspendedAt el momento que fleet reportó — se usa como createdAt del hold (preserva el origen).
   * @param documentType el tipo de documento vencido (causeRef del hold). Distingue cada doc de los demás.
   * @returns `true` si esta llamada efectivamente creó un hold nuevo; `false` si fue no-op (ya existía / sin perfil).
   */
  async suspendByFleet(driverId: string, suspendedAt: Date, documentType: string): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { id: true } });
      if (!driver) return false; // evento antes del onboarding: no-op silencioso (coherente con el viejo CAS).
      const { created } = await this.addHoldAt(
        tx,
        driverId,
        SuspensionCause.DOCUMENT_EXPIRED,
        documentType,
        `Documento crítico vencido (${documentType})`,
        suspendedAt,
      );
      return created;
    });
  }

  /**
   * Suspende un conductor por orden de fleet-service cuando el evento llega keyeado por **User.id** (no por
   * el id de perfil Driver). Es el caso de la INSPECCIÓN técnica (ITV) vencida: fleet SOLO tiene
   * `Vehicle.driverId` = User.id y NO traduce a id de perfil — identity es el dueño del mapeo, así que LO
   * RESUELVE acá (`Driver.userId → Driver.id`) y recién ENTONCES suspende. Esto evita el bug: pasar un User.id
   * donde se espera un Driver.id suspendería al conductor EQUIVOCADO. El `userId` es @unique → 0..1 fila.
   *
   * Bajo el modelo de HOLDS: agrega un hold INSPECTION_EXPIRED (causeRef `''`, una sola ITV). Es UNA CAUSA
   * DISTINTA de DOCUMENT_EXPIRED → coexiste con los holds de documento: regularizar el SOAT no quita la ITV y
   * viceversa (la CRÍTICA, resuelta de raíz). Idempotente por el `@@unique`. Sin perfil → no-op silencioso.
   *
   * @returns `true` si esta llamada efectivamente creó un hold nuevo; `false` si fue no-op.
   */
  async suspendByFleetForUser(userId: string, suspendedAt: Date): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      // Resolución User.id → Driver.id (identity es el dueño del mapeo). Sin perfil → no-op (evento prematuro).
      const driver = await tx.driver.findUnique({ where: { userId }, select: { id: true } });
      if (!driver) return false;
      const { created } = await this.addHoldAt(
        tx,
        driver.id,
        SuspensionCause.INSPECTION_EXPIRED,
        '',
        'Inspección técnica (ITV) vencida',
        suspendedAt,
      );
      return created;
    });
  }

  /**
   * AUTO-suspensión del conductor por RATING bajo (decisión del dueño · compliance/seguridad). La DECIDE
   * rating-service (evento `driver.flagged` reason='suspension', que ya aplicó el MÍNIMO de reseñas: identity
   * NO re-evalúa el promedio ni el conteo, solo materializa la decisión). El `driverId` del evento es el id de
   * PERFIL Driver (= `Trip.driverId`, invariante verificado en trip-service) → se usa DIRECTO, sin resolver por
   * userId (a diferencia de la vía ITV).
   *
   * Bajo el modelo de HOLDS: agrega un hold RATING_LOW (`causeRef = ''`, un solo hold de rating; re-flags del
   * mismo conductor son no-op). Es una causa NO-DISCIPLINARY: la levanta el override de compliance del operador
   * (reactivateForCompliance) — reactivación MANUAL, NUNCA se auto-levanta al recuperar el rating. Recomputa
   * `Driver.suspendedAt`, que es lo que el gate de turno (startShift) y el eligibility de dispatch leen (BR-I02).
   *
   * GUARD DE EXISTENCIA (anti poison-pill, espejo de suspendByFleet): si el Driver NO existe (purgado por
   * derecho-al-olvido, o un flag que llegó antes del onboarding), no-op silencioso ANTES de tocar holds/recompute
   * — sin esto, recomputeSuspendedAt haría un `driver.update` sobre un id inexistente → P2025 → Kafka reintenta ∞.
   *
   * IDEMPOTENTE por el `@@unique([driverId, cause, causeRef])`: re-entregas del MISMO flag → upsert no-op, NO
   * reescribe el momento NI re-suspende.
   *
   * @returns `true` si esta llamada efectivamente creó un hold nuevo; `false` si fue no-op (ya existía / sin perfil).
   */
  async suspendByRating(driverId: string, reason: string): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { id: true } });
      if (!driver) return false; // flag antes del onboarding / driver purgado: no-op silencioso (anti poison-pill).
      const { created } = await this.addHold(
        tx,
        driverId,
        SuspensionCause.RATING_LOW,
        '',
        reason,
      );
      return created;
    });
  }

  /**
   * AUTO-suspensión por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad). dispatch-service ya
   * decidió (cruzó el umbral en la ventana rolling de 24h, evento `driver.excessive_cancellations`); identity NO
   * re-evalúa, solo MATERIALIZA. El `driverId` es el id de PERFIL Driver (= `Trip.driverId`, el mismo que resolvió
   * dispatch vía `driverForTrip`) → se usa DIRECTO, sin resolver por userId (igual que suspendByRating).
   *
   * PRIMER HOLD TEMPORAL del sistema: agrega un hold EXCESSIVE_CANCELLATIONS (`causeRef = ''`, un solo hold) con
   * `expiresAt = now + COOLDOWN` → un sweeper (@Cron) lo auto-levanta al vencer (sin intervención del operador). Es
   * una causa NO-DISCIPLINARY: el operador también puede levantarla ANTES vía el override de compliance
   * (reactivateForCompliance, que barre `cause != DISCIPLINARY`). Recomputa `Driver.suspendedAt`, que es lo que el
   * gate de turno (startShift) y el eligibility de dispatch leen (BR-I02).
   *
   * GUARD DE EXISTENCIA (anti poison-pill, espejo de suspendByRating/suspendByFleet): si el Driver NO existe
   * (purgado / evento que llegó antes del onboarding), no-op silencioso ANTES de tocar holds/recompute — sin esto,
   * recomputeSuspendedAt haría un `driver.update` sobre un id inexistente → P2025 → Kafka reintenta ∞.
   *
   * IDEMPOTENTE por el `@@unique([driverId, cause, causeRef])`: una RE-ENTREGA del MISMO evento → upsert no-op,
   * NO reescribe el momento, NO re-suspende, y CRÍTICO: NO EXTIENDE el cooldown (el `update: {}` preserva el
   * `expiresAt` original). Un cruce REAL nuevo (tras vencer y removerse el hold) sí estampa un cooldown fresco.
   *
   * @returns `true` si esta llamada creó un hold nuevo; `false` si fue no-op (ya existía / sin perfil).
   */
  async suspendByCancellations(driverId: string, reason: string): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { id: true } });
      if (!driver) return false; // evento antes del onboarding / driver purgado: no-op silencioso (anti poison-pill).
      const expiresAt = new Date(Date.now() + this.cancellationCooldownMs);
      const { created } = await this.addHold(
        tx,
        driverId,
        SuspensionCause.EXCESSIVE_CANCELLATIONS,
        '',
        reason,
        expiresAt,
      );
      return created;
    });
  }

  /**
   * Reactiva un conductor por orden de fleet-service cuando REGULARIZÓ un documento crítico vencido
   * (`fleet.driver_reactivated` keyeado por `driverId` de perfil + `documentType`). Bajo el modelo de HOLDS:
   * quita SOLO el hold DOCUMENT_EXPIRED de ESE `documentType` (el evento lleva el documentType). Las otras
   * causas (otro documento, ITV, DISCIPLINARY) NUNCA se tocan → si quedan, el conductor SIGUE suspendido. Es
   * la INVERSA EXACTA de `suspendByFleet` (mismo natural key). Recomputa `suspendedAt`.
   *
   * IDEMPOTENTE: borrar un hold inexistente (ya regularizado, o nunca existió) = 0 filas → no-op. Re-entregas
   * del mismo evento no rompen. Una DISCIPLINARY NUNCA matchea (causa distinta) — fail-closed por construcción.
   *
   * NO toca `currentStatus`: reactivar solo levanta la suspensión; volver a operar lo decide el gate biométrico
   * de inicio de turno (BR-I02), igual que `reactivate()` manual.
   *
   * @returns `true` si esta llamada efectivamente quitó un hold; `false` si fue no-op.
   */
  async reactivateByFleet(driverId: string, documentType: string): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      // GUARD DE EXISTENCIA (espejo de suspendByFleet/suspendByFleetForUser/reactivateByFleetForUser): si el
      // Driver NO existe (purgado por derecho-al-olvido, o un evento que llegó antes del onboarding), salir
      // no-op ANTES de tocar holds/recompute. Sin esto, removeHolds→recomputeSuspendedAt hace
      // `tx.driver.update({ where: { id } })` que lanza P2025 (record-not-found) → el consumer de
      // `fleet.driver_reactivated` re-lanza → Kafka reintenta ∞ → POISON-PILL que bloquea la partición
      // (platform-wide). Con el guard, un driver inexistente se trata como YA procesado (return false).
      const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { id: true } });
      if (!driver) return false;
      const { removed } = await this.removeHolds(tx, driverId, {
        cause: SuspensionCause.DOCUMENT_EXPIRED,
        causeRef: documentType,
      });
      return removed > 0;
    });
  }

  /**
   * Reactiva un conductor por orden de fleet-service cuando el evento llega keyeado por **User.id** (no por
   * el id de perfil Driver). Es el caso de la INSPECCIÓN técnica (ITV) regularizada: fleet SOLO tiene
   * `Vehicle.driverId` = User.id — identity resuelve `Driver.userId → Driver.id`. Espejo de
   * `suspendByFleetForUser`: evita el bug de tratar el User.id como id de perfil.
   *
   * Bajo el modelo de HOLDS: quita SOLO el hold INSPECTION_EXPIRED. Las otras causas (documentos, DISCIPLINARY)
   * NUNCA se tocan → si quedan, el conductor SIGUE suspendido. Idempotente (borrar 0 holds = no-op).
   *
   * @returns `true` si esta llamada efectivamente quitó un hold; `false` si fue no-op.
   */
  async reactivateByFleetForUser(userId: string): Promise<boolean> {
    return this.prisma.write.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { userId }, select: { id: true } });
      if (!driver) return false;
      const { removed } = await this.removeHolds(tx, driver.id, {
        cause: SuspensionCause.INSPECTION_EXPIRED,
        causeRef: '',
      });
      return removed > 0;
    });
  }

  /**
   * Enrolamiento KYC con UNA selfie + liveness PASIVO (PAD single-frame, sin frames extra → sin lag): el
   * conductor manda una sola foto y biometric-service `POST /v1/enroll-passive` corre el anti-spoofing sobre
   * ESA misma selfie ANTES de derivar el embedding de referencia ArcFace. Defensa en profundidad: el PAD acá
   * (registro) + el face-match DNI/licencia↔selfie del binding (matchDniFace/matchLicenseFace, que el operador
   * VE antes de aprobar) + el liveness ACTIVO por reto del gate de turno (verifyBiometric). Flujo:
   *   1. La app captura UNA selfie.
   *   2. POST /drivers/biometric/enroll con { photo } (base64 sin prefijo data:).
   *
   * Dos rechazos fail-closed (422 tipado, degradación HONESTA, sin embedding falso): un ATAQUE DE PRESENTACIÓN
   * que el PAD detecta (reason 'spoof') o un rostro NO procesable (embedding vacío → reason 'no_face'). Si pasa,
   * persiste el embedding + `faceEnrolledAt` en UNA tx — el gate `hasFaceEmbedding` (aprobación del operador +
   * inicio de turno) lo lee como fuente única de "enrolado".
   *
   * AUDITORÍA (Ley 29733 · traza inmutable): emite `biometric.enrolled` (éxito, ATÓMICO con la persistencia del
   * embedding) y `biometric.enroll_rejected` (spoof, escritura propia FORENSE que persiste aunque el request
   * termine en 422) por outbox → audit-service. Ningún enrol ni intento de suplantación queda sin rastro.
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
    input: { photo: string; selfieKey?: string },
  ): Promise<{ enrolled: true; enrolledAt: string }> {
    const d = await this.prisma.read.driver.findUnique({ where: { userId } });
    if (!d) throw new NotFoundError('Conductor no encontrado');

    // TECHO DE ABUSO DEL ENROL (anti-hammering del PAD, fail-fast ANTES de gastar inferencia): tras
    // MAX_ENROLL_SPOOFS rechazos por spoof seguidos, cooldown temporal CORTO (no atrapa 1h a un conductor
    // legítimo). Se limpia al enrolar OK; la central destraba antes con el unlock admin.
    const spoofLockKey = enrollSpoofLockKey(d.id);
    const spoofs = Number((await this.redis.get(spoofLockKey)) ?? 0);
    if (spoofs >= MAX_ENROLL_SPOOFS) {
      this.logger.warn(
        `Enrol KYC bloqueado por abuso: ${spoofs} spoofs en la ventana (driverId=${d.id})`,
      );
      throw new ForbiddenError(
        'Demasiados intentos con foto o pantalla. Esperá unos minutos e intentá de nuevo con tu rostro real.',
      );
    }

    // Liveness PASIVO (PAD single-frame, sin frames extra → sin lag): el motor corre el anti-spoofing sobre
    // la MISMA selfie ANTES del embedding. Si el modelo PAD no está cargado, degrada honesto a sin-liveness
    // (livenessChecked=false) — el comportamiento previo. El liveness ACTIVO por reto sigue en el turno.
    const enroll = await this.biometric.enrollPassive(input.photo);

    // GATE ANTI-SPOOFING (fail-closed): el PAD corrió y el veredicto NO es persona viva → ataque de
    // presentación (foto impresa / pantalla / replay). NO se enrola. Decisión por BOOLEANOS, no por `reason`.
    if (enroll.livenessChecked && !enroll.live) {
      // FORENSE (Ley 29733): el intento de suplantación deja TRAZA INMUTABLE antes de rechazar. Escritura
      // propia e independiente (mismo espíritu que biometric.failed del turno): el camino de rechazo ni toca
      // al Driver, así que la evidencia se persiste con su evento aunque el request termine en 422.
      const rejected = createEnvelope({
        eventType: 'biometric.enroll_rejected',
        producer: 'identity-service',
        payload: {
          driverId: d.id,
          userId,
          reason: ENROLL_REJECT_SPOOF,
          score: enroll.score,
          at: new Date().toISOString(),
        },
      });
      await this.prisma.write.outboxEvent.create({
        data: {
          aggregateId: d.id,
          eventType: rejected.eventType,
          envelope: rejected as unknown as Prisma.InputJsonValue,
        },
      });
      // Suma al techo de abuso (anti-hammering): N spoofs seguidos → cooldown. `expire` en el primero fija la
      // ventana; cada spoof posterior solo incrementa (no resetea el TTL → la ventana no se extiende sola).
      const spoofCount = await this.redis.incr(spoofLockKey);
      if (spoofCount === 1) await this.redis.expire(spoofLockKey, ENROLL_SPOOF_LOCK_TTL_SECONDS);
      this.logger.warn(
        `Enrol KYC rechazado por anti-spoofing pasivo (driverId=${d.id}, score=${enroll.score}, intento=${spoofCount})`,
      );
      throw new UnprocessableEntityError(
        'No detectamos a una persona real frente a la cámara. Evitá fotos o pantallas e intentá de nuevo.',
        { reason: ENROLL_REJECT_SPOOF },
      );
    }

    const embedding = enroll.embedding ?? [];
    // GATE DE ROSTRO (fail-closed): si el motor no detecta una cara, el embedding viene vacío → 422 tipado.
    // La app degrada HONESTO ("No detectamos tu rostro") y pide reintentar la selfie. Nunca un PASS inventado.
    // (no_face NO se audita: es ruido operativo —no se detectó persona—, no un evento de identidad/seguridad.)
    if (!embedding.length) {
      throw new UnprocessableEntityError('No detectamos tu rostro', { reason: ENROLL_REJECT_NO_FACE });
    }

    const enrolledAt = new Date();
    // F5 · key de la selfie (ADICIONAL, ayuda visual del operador). DEFENSE-IN-DEPTH: solo se acepta si tiene
    // el prefijo del PROPIO conductor (`drivers/{driverId}/`) — NO se confía en una key arbitraria del caller,
    // aunque sea interno y firmado. Se persiste SOLO en este path VIVO (un spoof nunca llega acá). Si no vino
    // (subida best-effort del BFF falló) o el prefijo no calza → null (degradación honesta, sin selfie).
    const selfieKey =
      input.selfieKey && input.selfieKey.startsWith(`drivers/${d.id}/`) ? input.selfieKey : null;
    // AUDITORÍA ATÓMICA (Ley 29733): el embedding de referencia y la traza inmutable del enrol se persisten
    // JUNTOS en una sola tx (o ambos, o ninguno) — nunca un enrol sin su evidencia ni un evento sin enrol.
    const enrolled = createEnvelope({
      eventType: 'biometric.enrolled',
      producer: 'identity-service',
      payload: {
        driverId: d.id,
        userId,
        livenessChecked: enroll.livenessChecked,
        score: enroll.score,
        at: enrolledAt.toISOString(),
      },
    });
    await this.prisma.write.$transaction(async (tx) => {
      await tx.driver.update({
        where: { id: d.id },
        data: {
          faceEmbedding: embedding,
          faceEnrolledAt: enrolledAt,
          // F5 · selfie del enrol (ayuda visual del operador). Validada por prefijo arriba; null si no aplica.
          faceSelfieKey: selfieKey,
          // RESET DEL BINDING DNI↔selfie (invariante de frescura, mismo patrón que resubmit()): mutar el
          // embedding invalida el cotejo viejo (apuntaba al material anterior). Los 3 campos del binding se
          // limpian JUNTO al embedding nuevo → re-aprobar OBLIGA a re-correr matchDniFace() contra este material.
          dniFaceMatched: null,
          dniFaceMatchScore: null,
          dniFaceMatchedAt: null,
          // Idéntico para el binding licencia↔selfie (Lote C): el embedding nuevo invalida el cotejo del brevete.
          licenseFaceMatched: null,
          licenseFaceMatchScore: null,
          licenseFaceMatchedAt: null,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: d.id,
          eventType: enrolled.eventType,
          envelope: enrolled as unknown as Prisma.InputJsonValue,
        },
      });
    });
    // Enrol OK: el conductor demostró ser una persona real → limpia el contador de abuso (no arrastra spoofs
    // viejos a la próxima captura). Idempotente si no había contador.
    await this.redis.del(spoofLockKey);
    // DEGRADADO (observabilidad · F4): si el PAD no corrió (modelo ausente) el enrol quedó SIN anti-spoofing.
    // En prod no debería pasar (fail-closed por /health/ready); un WARN acá es la alarma si igual ocurre.
    if (!enroll.livenessChecked) {
      this.logger.warn(
        `Enrol KYC SIN liveness pasivo: el PAD no corrió (modelo ausente) — driverId=${d.id}`,
      );
    }
    return { enrolled: true, enrolledAt: enrolledAt.toISOString() };
  }

  /**
   * Destrabe biométrico por la CENTRAL (acción admin · regla #1 driver: "Sin override de UI — solo central
   * puede destrabar"). Limpia AMBOS bloqueos del conductor: el lockout del gate de TURNO (3 fallos → 1h) y el
   * cooldown de abuso del ENROL (spoofs). Da a la central la palanca que la regla le asigna (antes el único
   * destrabe era el auto-TTL). Idempotente: si no había bloqueo, no rompe. El comando lo audita el admin-bff.
   */
  async clearBiometricLockout(driverId: string): Promise<void> {
    const driver = await this.prisma.read.driver.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
    if (!driver) throw new NotFoundError('Conductor no encontrado', { driverId });
    await this.redis.del(bioLockKey(driverId));
    await this.redis.del(enrollSpoofLockKey(driverId));
    this.logger.log(`Verificación biométrica destrabada por la central (driverId=${driverId})`);
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
   * Lote C · BINDING licencia↔selfie (gemelo de matchDniFace, binding MÁS FUERTE). Cotea la foto del brevete
   * (LICENSE_A1, que el admin-bff baja de S3) contra el `faceEmbedding` de referencia GUARDADO del conductor
   * (server-truth, NO uno del caller) y PERSISTE el resultado en los 3 campos `licenseFace*` en UNA escritura
   * atómica. El operador lo VE antes de aprobar; el gate de `approve()` exige que el cotejo se HAYA EJECUTADO
   * (`licenseFaceMatchedAt != null`), NO un veredicto positivo.
   *
   * Reusa el puerto `biometric.matchDniFace` — la operación del motor es GENÉRICA (match de una foto-de-rostro
   * contra un embedding; `/v1/face-match` no sabe de qué documento viene). El nombre del puerto es histórico;
   * acá la semántica de DOMINIO (qué documento, qué columnas) la pone este método.
   *
   * NOTA DE CALIBRACIÓN: el brevete trae una foto de MENOR resolución que el DNI → el score tiende a ser más
   * bajo y un NO_MATCH legítimo es más probable. Por eso el gate es de EJECUCIÓN y el veredicto lo decide el
   * operador. El umbral de display puede requerir calibración aparte del DNI (DEUDA).
   *
   * Sin biometría enrolada → 409 tipado (mismo predicado `hasFaceEmbedding` que matchDniFace/approve/turno).
   */
  async matchLicenseFace(
    driverId: string,
    input: { image: string },
  ): Promise<BiometricDniMatchResult> {
    const driver = await this.prisma.read.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new NotFoundError('Conductor no encontrado', { driverId });
    if (!hasFaceEmbedding(driver)) {
      throw new ConflictError('El conductor no tiene biometría facial enrolada', { driverId });
    }

    // Match de la foto del BREVETE (S3) contra el embedding GUARDADO. Mismo puerto genérico que el DNI.
    const result = await this.biometric.matchDniFace({
      image: input.image,
      referenceEmbedding: driver.faceEmbedding,
    });

    // GUARDA el binding de licencia en UNA escritura atómica (veredicto + score crudo 0..100 + momento juntos).
    await this.prisma.write.driver.update({
      where: { id: driverId },
      data: {
        licenseFaceMatched: result.matched,
        licenseFaceMatchScore: result.score,
        licenseFaceMatchedAt: new Date(),
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
      this.logger.warn(
        `Gate de turno bloqueado: ${fails} fallos biométricos en 1h (driverId=${d.id})`,
      );
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
   * de que exista fila Driver (la licencia llega en `onboard`, paso posterior). La materialización del
   * cascarón + el `driver.registered` exactly-once viven en `materializeDriverShell` (ver su doc): crea con
   * los defaults del agregado + los datos personales si no existe, o solo actualiza el slice personal si ya
   * existe — sin el viejo 404 que bloqueaba el paso 1. Atómico a nivel DB sobre el unique, sin carrera con
   * un `onboard` concurrente.
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
    await this.materializeDriverShell(
      userId,
      {
        userId,
        currentStatus: DriverStatus.OFFLINE,
        backgroundCheckStatus: BackgroundCheckStatus.PENDING,
        legalName: input.legalName,
        documentIdEnc,
        birthDate,
      },
      {
        legalName: input.legalName,
        documentIdEnc,
        birthDate,
      },
    );
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
