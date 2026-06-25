/**
 * Controlador gRPC de identity (paquete veo.identity.v1.IdentityService).
 * Lectura síncrona de identidad para otros servicios. Devuelve `found=false` en vez de lanzar,
 * para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, InternalAudience, type InternalIdentity } from '@veo/auth';
import { DniFaceMatchStatus, PassiveLivenessStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { open } from '../common/secret-box';
import type { Env } from '../config/env.schema';

interface GetByIdRequest {
  id: string;
}
interface UserReply {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
  name: string;
}
interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
  /** ISO-8601 de la suspensión del conductor; "" si NO está suspendido (gate de elegibilidad PUJA). */
  suspendedAt: string;
  /** BE-1b · nombre visible del conductor: legal_name del onboarding (lo que escribe la app), fallback User.name. "" si no registrado. */
  name: string;
  /** Motivo del último rechazo de antecedentes; "" si NO está rechazado o no se dio motivo. */
  rejectionReason: string;
  /** Licencia/DNI del conductor (Compliance+ · revisión del operador); "" si no registrada. */
  licenseNumber: string;
  /** Estado KYC del usuario asociado (driver→user); "" si no incluido. */
  kycStatus: string;
  /** ISO-8601 de alta del conductor; "" si no disponible. */
  createdAt: string;
  /** ISO-8601 del enrolamiento biométrico facial; "" si aún no enroló. */
  faceEnrolledAt: string;
  /** ISO-8601 de la última verificación biométrica en vivo; "" si nunca verificó. */
  lastVerifiedAt: string;
  /** Teléfono del usuario asociado (driver→user); "" si no registrado. */
  phone: string;
  /** DNI del conductor (documento de identidad · Compliance+); "" si no registrado. */
  documentId: string;
  /** Fecha de nacimiento del conductor en `yyyy-mm-dd`; "" si no registrada. */
  birthDate: string;
  /** Sub-lote 3C · estado del binding DNI↔selfie (NOT_RUN/MATCHED/NO_MATCH). */
  dniFaceMatchStatus: string;
  /** Score del face-match en 0..100; 0 si no se corrió. */
  dniFaceMatchScore: number;
  /** ISO-8601 de cuándo se corrió el face-match; "" si no se corrió. */
  dniFaceMatchedAt: string;
  /** Lote C · estado del binding licencia↔selfie (NOT_RUN/MATCHED/NO_MATCH). */
  licenseFaceMatchStatus: string;
  /** Score del face-match del brevete en 0..100; 0 si no se corrió. */
  licenseFaceMatchScore: number;
  /** ISO-8601 de cuándo se corrió el face-match del brevete; "" si no se corrió. */
  licenseFaceMatchedAt: string;
  /** F5 · key S3/MinIO de la selfie del enrol (ADMIN-ONLY). "" si no hay/no-admin. */
  faceSelfieKey: string;
  /** Estado del liveness PASIVO del enrol (NOT_RUN/PASSED/DEGRADED · ADMIN-ONLY). NOT_RUN en no-admin. */
  livenessStatus: string;
  /** Score de la clase viva del PAD en 0..1; 0 si no se corrió o no-admin. */
  livenessScore: number;
  /**
   * CAUSAS ACTIVAS de la suspensión (modelo de HOLDS): las `cause` DISTINTAS de los holds vigentes del
   * conductor (DISCIPLINARY/DOCUMENT_EXPIRED/INSPECTION_EXPIRED). [] si NO está suspendido. Lo consume el
   * admin-bff para saber POR QUÉ está suspendido y elegir el endpoint de reactivación correcto. NO es PII.
   */
  suspensionCauses: string[];
}

/** Request batch de GetDriversByIds (lectura para listados del admin). */
interface DriverIdsRequest {
  ids: string[];
}

/** Reply batch de GetDriversByIds. Orden libre; el consumidor mapea por id. */
interface DriversByIdsReply {
  drivers: DriverReply[];
}

const EMPTY_DRIVER: DriverReply = {
  id: '',
  userId: '',
  currentStatus: '',
  backgroundCheckStatus: '',
  averageRating: 0,
  found: false,
  suspendedAt: '',
  name: '',
  rejectionReason: '',
  licenseNumber: '',
  kycStatus: '',
  createdAt: '',
  faceEnrolledAt: '',
  lastVerifiedAt: '',
  phone: '',
  documentId: '',
  birthDate: '',
  dniFaceMatchStatus: DniFaceMatchStatus.NOT_RUN,
  dniFaceMatchScore: 0,
  dniFaceMatchedAt: '',
  licenseFaceMatchStatus: DniFaceMatchStatus.NOT_RUN,
  licenseFaceMatchScore: 0,
  licenseFaceMatchedAt: '',
  faceSelfieKey: '',
  livenessStatus: PassiveLivenessStatus.NOT_RUN,
  livenessScore: 0,
  suspensionCauses: [],
};

/**
 * Métodos gRPC de IdentityService scopeados por RIEL. Cada RPC declara EXACTAMENTE qué rieles puede
 * invocarla (derivado de los callers reales · cross-rail / confused-deputy H7): el HMAC válido NO basta,
 * el `aud` firmado del caller DEBE estar en esta lista o se rechaza fail-closed (PERMISSION_DENIED).
 * Mapa tipado y centralizado — NUNCA un string mágico ni un `ALLOWED_AUDIENCES` global que deje pasar
 * cualquier riel a cualquier método.
 */
const GRPC_METHOD_AUDIENCES = {
  GetUser: [
    InternalAudience.DRIVER_RAIL,
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.ADMIN_RAIL,
  ],
  GetDriver: [
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.ADMIN_RAIL,
    InternalAudience.SERVICE_RAIL,
  ],
  GetDriverByUser: [InternalAudience.DRIVER_RAIL],
  // BATCH de conductores. DOS rieles, ambos verificados contra los callers reales:
  //  - ADMIN_RAIL (admin-bff `listDrivers`): nombre/teléfono por página de la lista del operador.
  //  - SERVICE_RAIL (booking-service · enriquecimiento de la BÚSQUEDA de carpooling F2): resuelve los
  //    datos PÚBLICOS del conductor (name/averageRating + ejes de elegibilidad) para los N viajes de la
  //    página en UNA sola llamada (anti-N+1). El batch NO descifra el DNI ni emite PII sensible
  //    (minimización 5b · `toDriverReply` sin `includeSensitivePii`), así que es seguro que un servicio
  //    interno (service-rail) lo consuma. El scoping admin-only era correcto SOLO cuando el único caller
  //    era admin-bff; al cablearse booking (service-rail) la búsqueda caía fail-closed → resultados vacíos.
  // Mínimo privilegio: NO se abre a public-rail ni driver-rail (no son callers legítimos del batch).
  GetDriversByIds: [InternalAudience.ADMIN_RAIL, InternalAudience.SERVICE_RAIL],
} as const satisfies Record<string, readonly InternalAudience[]>;

type GrpcMethodName = keyof typeof GRPC_METHOD_AUDIENCES;

@Controller()
export class IdentityGrpcController {
  private readonly logger = new Logger(IdentityGrpcController.name);
  private readonly secret: string;
  /** Clave de cifrado del DNI del conductor en reposo (AES-256-GCM · secret-box). Identity es el dueño del
   * dato y del secret: descifra acá, en el borde, ANTES de mandar el DNI al admin-bff (gateado Compliance+).
   * El secret NO se reparte a otros servicios. */
  private readonly dniEncKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
    this.dniEncKey = config.get('DRIVER_DNI_ENC_KEY', { infer: true });
  }

  /**
   * Verifica la identidad interna firmada (HMAC) Y acota el RIEL emisor al conjunto permitido del MÉTODO
   * (scoping por-RPC · confused-deputy). Dos rechazos distintos y honestos:
   *  - firma ausente/inválida → UNAUTHENTICATED (no probó quién es).
   *  - firma válida pero riel no autorizado para este método → PERMISSION_DENIED (probó quién es, no puede).
   */
  private requireIdentity(method: GrpcMethodName, metadata: Metadata): InternalIdentity {
    // Paso 1: firma. Sin allowedAudiences acá → distinguimos "no autenticado" de "autenticado pero sin permiso".
    const identity = verifyGrpcIdentity(metadata, this.secret);
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    // Paso 2: riel. El `aud` firmado del caller debe estar en la lista del método (fail-closed).
    const allowed: readonly InternalAudience[] = GRPC_METHOD_AUDIENCES[method];
    if (!allowed.includes(identity.aud)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'Riel no autorizado para esta operación',
      });
    }
    return identity;
  }

  @GrpcMethod('IdentityService', 'GetUser')
  async getUser({ id }: GetByIdRequest, metadata: Metadata): Promise<UserReply> {
    this.requireIdentity('GetUser', metadata);
    const u = await this.prisma.read.user.findUnique({ where: { id } });
    if (!u) {
      return { id: '', phone: '', type: '', kycStatus: '', deleted: false, found: false, name: '' };
    }
    return {
      id: u.id,
      phone: u.phone ?? '',
      type: u.type,
      kycStatus: u.kycStatus,
      deleted: u.deletedAt !== null,
      found: true,
      name: u.name ?? '',
    };
  }

  @GrpcMethod('IdentityService', 'GetDriver')
  async getDriver({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverReply> {
    const identity = this.requireIdentity('GetDriver', metadata);
    // MINIMIZACIÓN POR RIEL (Ley 29733 · H8 confused-deputy de DATO): GetDriver lo invocan TRES rieles
    // con necesidades distintas — verificado contra los consumidores reales del DriverReply:
    //  - PUBLIC_RAIL (public-bff: detalle/listado/share): lee SOLO name/userId/status/rating → datos que
    //    el PASAJERO ve. NO lee DNI, licencia, fecha-nac ni biometría.
    //  - SERVICE_RAIL (dispatch: re-validar elegibilidad): lee SOLO id/userId/currentStatus/suspendedAt.
    //  - ADMIN_RAIL (admin-bff: revisión Compliance+): SÍ valida el DNI/licencia/fecha-nac/biometría a ojo.
    // Por eso la PII SENSIBLE (DNI descifrado, licencia, fecha de nacimiento, timestamps biométricos y el
    // binding DNI↔selfie) se descifra/emite SOLO si el caller es ADMIN_RAIL. Para los demás rieles NO se
    // descifra el DNI (no viaja por el cable) y los otros campos PII se omiten (proto3 default '').
    const includeSensitivePii = identity.aud === InternalAudience.ADMIN_RAIL;
    // BE-1b — `include: user` trae los scalars del Driver (incluido legalName) + el nombre/kyc/phone
    // del usuario (driver→user, ambos en identity: NO es join cross-servicio).
    const d = await this.prisma.read.driver.findUnique({
      where: { id },
      include: {
        user: { select: { name: true, kycStatus: true, phone: true } },
        // Holds VIGENTES: el admin-bff necesita las CAUSAS distintas para saber POR QUÉ está suspendido y
        // elegir el endpoint de reactivación (DISCIPLINARY → /reactivate; documento/ITV → /reactivate-compliance).
        // Solo el `cause` (no PII). El detalle Compliance+ es el único consumidor del DriverReply single.
        suspensionHolds: { select: { cause: true } },
      },
    });
    // El descifrado del DNI (único path costoso/peligroso) ocurre ÚNICAMENTE para ADMIN_RAIL, y aun ahí con
    // guarda (`openDniSafely`): un blob corrupto degrada a "" en vez de tumbar la RPC con un 500.
    return d ? this.toDriverReply(d, includeSensitivePii) : EMPTY_DRIVER;
  }

  @GrpcMethod('IdentityService', 'GetDriverByUser')
  async getDriverByUser({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverReply> {
    this.requireIdentity('GetDriverByUser', metadata);
    // `include: user` trae los scalars del Driver (incluido legalName) + nombre/kyc/phone del usuario.
    const d = await this.prisma.read.driver.findUnique({
      where: { userId: id },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  /**
   * Lectura BATCH para enriquecer listados del admin (nombre/teléfono por página, sin N+1): UNA query
   * `findMany WHERE id IN (...)`. El admin-bff la llama una vez por página con los driverId visibles.
   * Devuelve solo los hallados (orden libre — el consumidor mapea por id); ids vacíos → []. Idempotente.
   */
  @GrpcMethod('IdentityService', 'GetDriversByIds')
  async getDriversByIds(
    { ids }: DriverIdsRequest,
    metadata: Metadata,
  ): Promise<DriversByIdsReply> {
    this.requireIdentity('GetDriversByIds', metadata);
    if (!ids || ids.length === 0) return { drivers: [] };
    const drivers = await this.prisma.read.driver.findMany({
      where: { id: { in: ids } },
      include: {
        user: { select: { name: true, kycStatus: true, phone: true } },
        // Holds VIGENTES (solo el `cause`, NO PII): la LISTA del panel necesita las CAUSAS distintas para
        // ofrecer la(s) acción(es) de reactivación correcta(s) por fila (cause-aware), igual que el detalle.
        // SIN N+1: es una SOLA query batch (`findMany WHERE id IN (...)` con `include`) — Prisma trae los
        // holds de TODOS los ids en la misma ida a la DB, no un query por conductor. `toDriverReply` mapea
        // `suspensionCauses` (causas distintas, dedup con Set) cuando el row trae `suspensionHolds`.
        suspensionHolds: { select: { cause: true } },
      },
    });
    // BATCH/lista: NO se descifra el DNI (`includeDni` ausente → false). El admin-bff `listDrivers` consume
    // SOLO name/phone de este reply (jamás documentId), así que descifrar acá sería over-decryption de PII y
    // —peor— una fila con ciphertext corrupto/de-otra-clave tumbaría la página ENTERA de conductores. El DNI
    // se descifra únicamente en el GetDriver single (detalle Compliance+).
    return { drivers: drivers.map((d) => this.toDriverReply(d)) };
  }

  /**
   * Descifra el DNI del conductor con GUARDA (defensa en profundidad). `open()` LANZA ante un ciphertext
   * con formato inválido o un tag GCM que no valida (rotación de clave, escritura parcial): acá lo
   * envolvemos para que un blob corrupto DEGRADE a "" (campo vacío) en vez de tumbar la RPC con un 500.
   * El fallo NO se traga en silencio: se loguea structured `warn` con el driverId — NUNCA el ciphertext
   * ni la clave (no se filtra material sensible ni el blob al log).
   */
  private openDniSafely(documentIdEnc: string, driverId: string): string {
    try {
      return open(documentIdEnc, this.dniEncKey);
    } catch (err) {
      this.logger.warn({
        msg: 'No se pudo descifrar el DNI del conductor (ciphertext corrupto o clave incompatible); se degrada a vacío',
        driverId,
        cause: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  /**
   * Mapea una fila de Driver al reply gRPC. `includeSensitivePii` gobierna SOLO la PII VERDADERAMENTE
   * SENSIBLE (minimización por riel · Ley 29733 / H8): el DNI descifrado (`documentId`), la licencia
   * (`licenseNumber`), la fecha de nacimiento (`birthDate`) y el binding DNI↔selfie (`dniFaceMatch*`).
   * Esos son los datos que SOLO la revisión Compliance+ del admin valida a ojo — verificado contra los
   * consumidores reales: ni el pasajero (public-bff) ni el dispatch (service-rail) NI el propio conductor
   * (driver-bff sobre SU record) los leen. Por defecto `false` → NADA de eso se emite y el DNI NI SIQUIERA
   * se descifra (documentId: ''):
   *  - GetDriversByIds (BATCH/lista admin) y GetDriverByUser (driver-bff, deriva su propio id) pasan el
   *    default → evitan over-decryption + la superficie de crash del descifrado.
   *  - GetDriver con caller PUBLIC_RAIL/SERVICE_RAIL idem: el pasajero y dispatch NO ven esos campos.
   * Solo GetDriver con caller ADMIN_RAIL pasa `true`, y aun ahí el descifrado del DNI va con guarda
   * (`openDniSafely`): un blob corrupto degrada a "" sin tirar 500.
   *
   * IMPORTANTE — `faceEnrolledAt`/`lastVerifiedAt` NO están bajo este flag: son timestamps de ESTADO de
   * enrollment/verificación (no PII de identidad), y el PROPIO conductor los necesita en claro para su
   * onboarding (driver-bff `drivers.mapper.ts` deriva `biometricEnrolled = faceEnrolledAt.length > 0`, que
   * compone el gate `in_review`). Se emiten INCONDICIONAL en todos los rieles (al pasajero no le hacen daño:
   * es "verificado el X"). Meterlos en el set admin-only (regresión del lote 5b) dejaba al conductor con
   * `faceEnrolledAt=''` SIEMPRE en el driver-rail → trabado en el onboarding.
   */
  private toDriverReply(
    d: {
    id: string;
    userId: string;
    currentStatus: string;
    backgroundCheckStatus: string;
    averageRating: { toString(): string };
    suspendedAt: Date | null;
    legalName: string | null;
    rejectionReason: string | null;
    licenseNumber: string | null;
    documentIdEnc: string | null;
    birthDate: Date | null;
    createdAt: Date;
    faceEnrolledAt: Date | null;
    lastVerifiedAt: Date | null;
    dniFaceMatched: boolean | null;
    dniFaceMatchScore: number | null;
    dniFaceMatchedAt: Date | null;
    licenseFaceMatched: boolean | null;
    licenseFaceMatchScore: number | null;
    licenseFaceMatchedAt: Date | null;
    faceSelfieKey: string | null;
    livenessChecked: boolean | null;
    livenessScore: number | null;
    user?: { name: string | null; kycStatus?: string | null; phone?: string | null } | null;
    // Holds vigentes (solo el `cause`): presente cuando el query los incluyó (GetDriver single). Ausente en
    // los reads que NO los traen (batch/by-user) → suspensionCauses queda [] (el badge `suspendedAt` basta ahí).
    suspensionHolds?: { cause: string }[];
    },
    includeSensitivePii = false,
  ): DriverReply {
    return {
      id: d.id,
      userId: d.userId,
      currentStatus: d.currentStatus,
      backgroundCheckStatus: d.backgroundCheckStatus,
      averageRating: Number(d.averageRating.toString()),
      found: true,
      suspendedAt: d.suspendedAt ? d.suspendedAt.toISOString() : '',
      // BE-1b — nombre del conductor para el admin: PREFERIR legal_name del onboarding (lo que la app
      // escribe en `identity.drivers.legal_name`), fallback User.name. "" si ninguno está registrado.
      name: d.legalName || d.user?.name || '',
      // Motivo del último rechazo (dead-end fix); "" si no está rechazado o no se dio motivo.
      rejectionReason: d.rejectionReason ?? '',
      // PII SENSIBLE · ADMIN-ONLY (minimización por riel · Ley 29733 / H8). Estos campos los consume SOLO la
      // revisión Compliance+ del admin-bff (GET /ops/drivers/:id valida licencia/DNI/fecha-nac/binding a
      // ojo). Verificado contra los consumidores reales: ni public-bff (detalle/listado/share del pasajero),
      // ni dispatch (re-validación de elegibilidad), NI el propio conductor (driver-bff sobre su record) los
      // leen. Con caller no-admin → omitidos (proto3 ''):
      licenseNumber: includeSensitivePii ? (d.licenseNumber ?? '') : '',
      kycStatus: d.user?.kycStatus ?? '',
      createdAt: d.createdAt.toISOString(),
      // Timestamps de ESTADO de enrollment/verificación biométrica: INCONDICIONAL en todos los rieles. NO es
      // PII sensible de identidad — es la señal de "el conductor enroló/verificó su rostro" que el PROPIO
      // conductor necesita en su onboarding (driver-bff deriva `biometricEnrolled = faceEnrolledAt.length > 0`,
      // que compone el gate `in_review`). Al pasajero tampoco le hace daño (es "verificado el X"). Gatearlos
      // por riel (regresión 5b) trababa al conductor con faceEnrolledAt='' en el driver-rail.
      faceEnrolledAt: d.faceEnrolledAt ? d.faceEnrolledAt.toISOString() : '',
      lastVerifiedAt: d.lastVerifiedAt ? d.lastVerifiedAt.toISOString() : '',
      phone: d.user?.phone ?? '',
      // DNI + fecha de nacimiento para la revisión del operador (admin valida informado). El DNI vive CIFRADO
      // en reposo (PII Ley 29733): identity lo DESCIFRA acá, en el borde (es dueño del dato y del secret), antes
      // de mandarlo al admin-bff (gateado Compliance+). El secret NO se reparte. "" cuando no hay dato (proto3
      // default, nunca null). birthDate es @db.Date → yyyy-mm-dd; "" cuando no hay dato.
      // SOLO se descifra/emite cuando el caller es ADMIN_RAIL (`includeSensitivePii`). public-bff/dispatch
      // pasan `false` → el DNI NI se descifra (no viaja por el cable) y birthDate se omite: ni over-decryption
      // de PII de gusto, ni fuga cross-rail, ni superficie de crash del descifrado para esos rieles. Y cuando
      // SÍ se descifra, va con guarda (`openDniSafely`): un blob corrupto degrada a "" en vez de tirar un 500.
      documentId:
        includeSensitivePii && d.documentIdEnc ? this.openDniSafely(d.documentIdEnc, d.id) : '',
      birthDate: includeSensitivePii && d.birthDate ? d.birthDate.toISOString().slice(0, 10) : '',
      // Sub-lote 3C · binding DNI↔selfie GUARDADO. ADMIN-ONLY (es señal del proceso KYC/DNI). El estado se
      // DERIVA del veredicto persistido (null = aún no se corrió → NOT_RUN; true → MATCHED; false → NO_MATCH):
      // estado tipado explícito, sin la ambigüedad del bool. Para rieles no-admin → NOT_RUN/0/"" (proto3
      // default honesto: el pasajero/dispatch no ven el binding biométrico del conductor).
      dniFaceMatchStatus:
        !includeSensitivePii || d.dniFaceMatched === null || d.dniFaceMatched === undefined
          ? DniFaceMatchStatus.NOT_RUN
          : d.dniFaceMatched
            ? DniFaceMatchStatus.MATCHED
            : DniFaceMatchStatus.NO_MATCH,
      dniFaceMatchScore: includeSensitivePii ? (d.dniFaceMatchScore ?? 0) : 0,
      dniFaceMatchedAt:
        includeSensitivePii && d.dniFaceMatchedAt ? d.dniFaceMatchedAt.toISOString() : '',
      // Lote C · binding licencia↔selfie GUARDADO. Mismo gateo ADMIN-ONLY + derivación que el DNI (null →
      // NOT_RUN; true → MATCHED; false → NO_MATCH). Para rieles no-admin → NOT_RUN/0/"" (proto3 default honesto).
      licenseFaceMatchStatus:
        !includeSensitivePii || d.licenseFaceMatched === null || d.licenseFaceMatched === undefined
          ? DniFaceMatchStatus.NOT_RUN
          : d.licenseFaceMatched
            ? DniFaceMatchStatus.MATCHED
            : DniFaceMatchStatus.NO_MATCH,
      licenseFaceMatchScore: includeSensitivePii ? (d.licenseFaceMatchScore ?? 0) : 0,
      licenseFaceMatchedAt:
        includeSensitivePii && d.licenseFaceMatchedAt ? d.licenseFaceMatchedAt.toISOString() : '',
      // F5 · key de la selfie del enrol. ADMIN-ONLY (igual que el DNI/binding): "" en rieles no-admin (el
      // pasajero/dispatch no ven la biometría del conductor) o si no hay selfie guardada.
      faceSelfieKey: includeSensitivePii ? (d.faceSelfieKey ?? '') : '',
      // LIVENESS PASIVO del enrol. ADMIN-ONLY (señal del proceso KYC). El status se DERIVA del `livenessChecked`
      // persistido (null = aún no enroló → NOT_RUN; true → PASSED, el PAD corrió y dio viva; false → DEGRADED,
      // enroló sin PAD): estado tipado explícito, sin la ambigüedad del bool. Para rieles no-admin → NOT_RUN/0.
      livenessStatus:
        !includeSensitivePii || d.livenessChecked === null || d.livenessChecked === undefined
          ? PassiveLivenessStatus.NOT_RUN
          : d.livenessChecked
            ? PassiveLivenessStatus.PASSED
            : PassiveLivenessStatus.DEGRADED,
      livenessScore: includeSensitivePii ? (d.livenessScore ?? 0) : 0,
      // CAUSAS de suspensión: las `cause` DISTINTAS de los holds vigentes (modelo de HOLDS). Un conductor con
      // varias causas (ej. doc vencido + disciplinaria) las muestra TODAS, así el panel ofrece la(s) acción(es)
      // de reactivación correcta(s). [] cuando el read no trajo holds (batch/by-user) o no hay holds (libre).
      // NO es PII; el `cause` es un enum de motivo. dedup con Set (ej. 2 holds DOCUMENT_EXPIRED de docs distintos).
      suspensionCauses: d.suspensionHolds ? [...new Set(d.suspensionHolds.map((h) => h.cause))] : [],
    };
  }
}
