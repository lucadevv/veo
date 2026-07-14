/**
 * OpsService — operación: listados (read-model), detalle agregado de viaje (gRPC fan-out) y
 * aprobaciones de conductores/operadores (REST interno firmado + auditoría).
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalRestClient,
  type GrpcServiceClient,
  type TripReply,
  type TripModesReply,
  type UserReply,
  type DriverReply,
  type DriversByIdsReply,
  type UsersByIdsReply,
  type DriverCountsReply,
  type VehicleCountsReply,
  type ReviewQueueCountsReply,
  type DriverDocsCompletenessReply,
  type DriverVehiclesReply,
  type VehicleReply,
  type VehiclesReply,
  type DriverDocumentsReply,
  type DriverInspectionStatusReply,
} from '@veo/rpc';
import { ConflictError, ForbiddenError, NotFoundError, isProdTier } from '@veo/utils';
import type { MapsClient } from '@veo/maps';
import { MAPS_CLIENT } from '../maps/maps.module';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser as AuthUser,
  type InternalAudience,
} from '@veo/auth';
import {
  canGrantRoles,
  DniFaceMatchStatus,
  DocumentSide,
  FleetDocumentType,
  FleetDocumentStatus,
  PassiveLivenessStatus,
  SuspensionCause,
  type AdminRole,
} from '@veo/shared-types';
import type {
  TripSummary,
  DriverApproval,
  DriverCounts,
  VehicleCounts,
  ReviewQueueSummary,
  TripDetail,
  DriverDetail,
  DriverVehicle,
  AdminDocumentImage,
  AdminDriverDocument,
  DocumentSideValue,
  DniFaceMatchStatusValue,
  PassiveLivenessStatusValue,
  DniFaceMatchResult,
  GeoPoint,
  OperatorDetail,
  OperatorSession,
  LiveCabin,
} from '@veo/api-client';
import { PERMISSION_LIST, baseGrants } from '@veo/policy';
import {
  GRPC_TRIP,
  GRPC_IDENTITY,
  GRPC_FLEET,
  REST_IDENTITY,
  REST_MEDIA,
  REST_TRIP,
  REST_FLEET,
  REST_PAYMENT,
} from '../infra/tokens';
import { ReadModelService, type Page } from '../read-model/read-model.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import {
  tripRecordToSummary,
  driverRecordToApproval,
  mapTripStatus,
  isLiveAdminTrip,
  type DriverListEnrichment,
} from './mappers';
import {
  canSeeIdentity,
  canSeePlate,
  canSeeExactTripGeo,
  maskPlate,
  coarseGeo,
} from '../redaction/redaction.policy';
import type { ListTripsQueryDto, ListDriversQueryDto } from './dto/ops.dto';

const DEFAULT_LIMIT = 25;

/** Valores válidos de DocumentSide (sub-lote 3A) para narrowear el `side` string del wire gRPC. */
const DOCUMENT_SIDE_VALUES = new Set<string>(Object.values(DocumentSide));

/**
 * Narrowea el `side` string del wire gRPC al enum tipado del contrato. Un valor desconocido degrada a
 * SINGLE (degradación honesta: el operador igual ve la imagen; el render no se rompe por un side raro).
 */
function toDocumentSide(side: string): DocumentSideValue {
  return DOCUMENT_SIDE_VALUES.has(side) ? (side as DocumentSideValue) : DocumentSide.SINGLE;
}

/**
 * Documentos OBLIGATORIOS para aprobar a un conductor (gate server-side autoritativo · Ley 29733).
 * Tipos del enum canónico de flota (NO magic strings): licencia A1 + SOAT + tarjeta de propiedad.
 * NOTA (reconciliación cerrada): `'VEHICLE_REGISTRATION'` es SOLO una etiqueta interna del wizard móvil
 * ("tarjeta de propiedad" en la UI); NUNCA viaja cruda. El móvil la traduce al `FleetDocumentType` canónico
 * `PROPERTY_CARD` en el borde del wire vía `registrationDocTypeToBackend` (switch exhaustivo sin `default`
 * + test de regresión P0), así que el presign del driver-bff (`@IsEnum(FleetDocumentType)`) recibe siempre
 * el tipo canónico. La cadena queda alineada de punta a punta (móvil→PROPERTY_CARD, fleet almacena
 * PROPERTY_CARD, este gate exige PROPERTY_CARD): no hay mismatch de string que reconciliar.
 */
const REQUIRED_DRIVER_DOC_TYPES = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
  // Ola 1 "solo autos": la FOTO del vehículo es obligatoria para aprobar — el operador NO aprueba sin
  // ver el auto. Sube en el alta (paso Vehículo) como doc DRIVER-scoped y llega acá vía GetDriverDocuments.
  FleetDocumentType.VEHICLE_PHOTO,
] as const;

/** Estados de la columna "Verificación" de la lista (combina los dos face-match). Tipados, sin magic strings. */
type VerificationStatus = 'VERIFICADO' | 'REVISAR' | 'PENDIENTE';

/**
 * Estado combinado de verificación biométrica para la LISTA, derivado de los dos face-match del batch de identity
 * (DNI + licencia): REVISAR si alguno dio NO_MATCH (el operador debe mirar), VERIFICADO si AMBOS coinciden,
 * PENDIENTE si aún no corrieron (NOT_RUN). Solo lee el ESTADO (no scores/DNI) — el batch no descifra nada.
 */
function deriveVerificationStatus(d: DriverReply): VerificationStatus {
  const both = [d.dniFaceMatchStatus, d.licenseFaceMatchStatus];
  if (both.includes(DniFaceMatchStatus.NO_MATCH)) return 'REVISAR';
  if (both.every((s) => s === DniFaceMatchStatus.MATCHED)) return 'VERIFICADO';
  return 'PENDIENTE';
}

/** proto3 entrega "" para strings ausentes; el contrato del panel los quiere `null` honesto. */
function emptyToNull(s: string): string | null {
  return s ? s : null;
}

/**
 * Normaliza el `dispatchMode` crudo de trip-service (PricingMode como string) al enum del contrato
 * (`tripSummary.dispatchMode`). '' (no hallado) o cualquier valor fuera de {FIXED,PUJA} → null honesto
 * (la UI cae a "—", nunca inventa un modo). Carpooling no es un dispatchMode de viaje on-demand (es otro
 * producto, booking-service) → no aparece acá.
 */
function normalizeDispatchMode(raw: string | undefined): 'FIXED' | 'PUJA' | null {
  return raw === 'FIXED' || raw === 'PUJA' ? raw : null;
}

/**
 * Mensaje del operador por cada motivo de invalidez de la ITV (gate de aprobación · compliance). El motivo
 * lo clasifica fleet (NONE|NOT_PASSED|OVERDUE = inspection-rules; NO_VEHICLE = sin vehículo operable).
 * Default (motivo desconocido del wire) = mensaje genérico de ausencia, fail-closed honesto.
 */
const INSPECTION_BLOCK_MESSAGE: Record<string, string> = {
  NONE: 'No se puede aprobar: el vehículo del conductor no tiene inspección técnica (ITV) registrada',
  NOT_PASSED: 'No se puede aprobar: la inspección técnica (ITV) del vehículo está reprobada',
  OVERDUE: 'No se puede aprobar: la inspección técnica (ITV) del vehículo está vencida',
  NO_VEHICLE:
    'No se puede aprobar: el conductor no tiene un vehículo operable con inspección técnica (ITV)',
};
const INSPECTION_BLOCK_DEFAULT = 'No se puede aprobar: inspección técnica (ITV) vencida o ausente';

/** Valores válidos de DniFaceMatchStatus (sub-lote 3C) para narrowear el string del wire gRPC. */
const DNI_FACE_MATCH_STATUS_VALUES = new Set<string>(Object.values(DniFaceMatchStatus));

/**
 * Narrowea el estado del binding DNI↔selfie del wire gRPC al enum tipado del contrato. Un valor desconocido
 * (o "" del proto3 default) degrada a NOT_RUN (degradación honesta: ante la duda, "no se corrió").
 */
function toDniFaceMatchStatus(status: string): DniFaceMatchStatusValue {
  return DNI_FACE_MATCH_STATUS_VALUES.has(status)
    ? (status as DniFaceMatchStatusValue)
    : DniFaceMatchStatus.NOT_RUN;
}

/** Valores válidos de PassiveLivenessStatus para narrowear el string del wire gRPC. */
const PASSIVE_LIVENESS_STATUS_VALUES = new Set<string>(Object.values(PassiveLivenessStatus));

/**
 * Narrowea el estado del liveness PASIVO del wire gRPC al enum tipado del contrato. Un valor desconocido
 * (o "" del proto3 default) degrada a NOT_RUN (degradación honesta: ante la duda, "no se corrió").
 */
function toPassiveLivenessStatus(status: string): PassiveLivenessStatusValue {
  return PASSIVE_LIVENESS_STATUS_VALUES.has(status)
    ? (status as PassiveLivenessStatusValue)
    : PassiveLivenessStatus.NOT_RUN;
}

/** Valores válidos de SuspensionCause (modelo de HOLDS) para narrowear las causas del wire gRPC. */
const SUSPENSION_CAUSE_VALUES = new Set<string>(Object.values(SuspensionCause));

/**
 * Narrowea las causas de suspensión del wire gRPC (`string[]`) al enum tipado del dominio, DESCARTANDO los
 * valores desconocidos (productor más nuevo con una causa que este BFF aún no conoce → se omite, nunca se
 * inventa una acción de reactivación sobre una causa que no entendemos). `undefined` (proto3 viejo) → [].
 */
function toSuspensionCauses(causes: string[] | undefined): SuspensionCause[] {
  return (causes ?? []).filter((c): c is SuspensionCause => SUSPENSION_CAUSE_VALUES.has(c));
}

/** Mensaje de causa legible de un error desconocido (para la degradación honesta del purge parcial). */
function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coords del proto (lng) → GeoPoint (lon); 0,0 (default proto3 = sin set) → null honesto. */
function toGeo(lat: number, lng: number): GeoPoint | null {
  if (!lat && !lng) return null;
  return { lat, lon: lng };
}

export interface PendingDriver {
  id: string;
  userId: string;
  licenseNumber: string | null;
  /** Nombre legal del onboarding (lo que el conductor cargó en la app); null si no lo cargó aún. */
  fullName: string | null;
  /** Completitud documental (docs REQUERIDOS en VALID / total) para el embudo Sin docs / Listos. No PII. */
  docsComplete: number;
  docsTotal: number;
  /** Verificación biométrica combinada (VERIFICADO/REVISAR/PENDIENTE); null para sub-Compliance (redactado). */
  verificationStatus: string | null;
  /** ISO-8601 de encolado (alta del conductor) para el SLA/orden de la cola de Revisiones; null si sin dato. */
  enqueuedAt: string | null;
}
export interface OperatorSummary {
  id: string;
  email: string;
  name: string | null;
  status: string;
  roles: string[];
  totpEnrolled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Detalle CRUDO que devuelve identity (GET /admin/operators/:id): la fila + sus sesiones. El admin-bff le
 * SUMA `effectivePermissions` (derivado de los roles con la matriz base @veo/policy) antes de exponerlo.
 */
interface IdentityOperatorDetail extends OperatorSummary {
  sessions: OperatorSession[];
}

export interface CreatedOperator {
  id: string;
  inviteToken: string;
  inviteUrl: string;
  expiresAt: string;
}

/** Forma que devuelve identity en el HARD purge (DELETE /drivers/:id). */
interface IdentityPurgeReply {
  userId: string;
  deleted: {
    driver: number;
    authMethods: number;
    biometricChecks: number;
    consents: number;
    user: number;
  };
}

/** Forma que devuelve trip-service en el guard de historial (GET /internal/drivers/:id/trip-count). */
interface DriverTripCountReply {
  driverId: string;
  tripCount: number;
  hasTrips: boolean;
}

/** Forma que devuelve fleet en el HARD purge (DELETE /vehicles/drivers/:driverId). */
interface FleetPurgeReply {
  documents: number;
  vehicles: number;
  vehicleDocuments: number;
}

/** Forma que devuelve media en el HARD purge (DELETE /media/internal/drivers/:driverId/documents). */
interface MediaPurgeReply {
  deleted: number;
}

/** Forma que devuelve trip-service en el HARD purge DEV (DELETE /internal/drivers/:driverId/trips). */
interface TripPurgeReply {
  driverId: string;
  trips: number;
  tripEvents: number;
  waypointProposals: number;
}

/**
 * Forma que devuelve payment-service en el HARD purge DEV
 * (DELETE /internal/drivers/:driverId/payments?userId=...). Contadores por id que indexa cada tabla.
 */
interface PaymentPurgeReply {
  driverId: string;
  userId: string;
  byDriverId: {
    cancellationPenalties: number;
    incentiveProgress: number;
    incentiveTripCredits: number;
    payments: number;
    payouts: number;
    refunds: number;
    tipAdditions: number;
  };
  byUserId: {
    promoRedemptions: number;
    userCreditEntries: number;
    userCredits: number;
    walletAffiliations: number;
  };
}

/**
 * Fallo parcial de un paso downstream del purge (identity YA borró; el resto del cascade no completó).
 * `trip`/`payment` solo aplican en el cascade DEV (en PROD el guard corta antes de borrar nada).
 */
export interface DriverPurgePartialFailure {
  stage: 'fleet' | 'media' | 'trip' | 'payment';
  cause: string;
}

/**
 * Resumen del HARD purge en cascada de un conductor (DELETE /ops/drivers/:id). Contadores por servicio.
 * `tripCount` documenta que el guard se evaluó (siempre 0 si el purge procedió). `projection.removed`
 * indica si había proyección Redis que sacar.
 */
export interface DriverPurgeSummary {
  driverId: string;
  userId: string;
  tripCount: number;
  identity: IdentityPurgeReply['deleted'];
  fleet: FleetPurgeReply;
  media: MediaPurgeReply;
  /**
   * Cascade DEV-only de los VIAJES del conductor (trip-service). Ausente en PROD: ahí el guard de
   * historial corta antes y el conductor va al flujo de olvido (BR-S06), nunca al hard-borrado de trips.
   */
  trip?: TripPurgeReply;
  /**
   * Cascade DEV-only del DINERO del conductor (payment-service). Ausente en PROD por el mismo motivo que
   * `trip`. En PROD el dinero se ANONIMIZA por el derecho al olvido (consumer de user.deleted), no se borra.
   */
  payment?: PaymentPurgeReply;
  projection: { removed: boolean };
  /**
   * Pasos downstream que NO completaron (identity SÍ borró y la proyección SÍ se limpió). Ausente cuando
   * todo el cascade fue OK; presente ⇒ purga PARCIAL: quedan binarios S3 / filas de flota por limpiar a mano.
   */
  partialFailures?: DriverPurgePartialFailure[];
}

@Injectable()
export class OpsService {
  private readonly secret: string;
  private readonly documentsBucket: string;

  constructor(
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
    @Inject(REST_MEDIA) private readonly mediaRest: InternalRestClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    @Inject(REST_FLEET) private readonly fleetRest: InternalRestClient,
    @Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    private readonly readModel: ReadModelService,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
    this.documentsBucket = config.get('S3_BUCKET_DOCUMENTS', { infer: true });
  }

  async listTrips(identity: AuthUser, query: ListTripsQueryDto): Promise<Page<TripSummary>> {
    const roles = identity.roles;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listTrips(
      { status: query.status, driverId: query.driverId, passengerId: query.passengerId },
      query.cursor ?? null,
      limit,
    );

    // Enriquecimiento por página SIN N+1: nombres de pasajero/conductor vía DOS batches gRPC a identity en
    // PARALELO (mismo patrón que listDrivers). PII (nombres · Ley 29733) SOLO para Compliance+ (canSeeIdentity);
    // sub-Compliance → null honesto. No vive en el read-model (los eventos no llevan PII) → se resuelve acá.
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const paxNameById = new Map<string, string | null>();
    const drvNameById = new Map<string, string | null>();
    if (canSeeIdentity(roles) && page.items.length > 0) {
      const passengerIds = [
        ...new Set(page.items.map((r) => r.passengerId).filter((id) => id.length > 0)),
      ];
      const driverIds = [
        ...new Set(page.items.map((r) => r.driverId).filter((id): id is string => !!id)),
      ];
      const [usersReply, driversReply] = await Promise.all([
        passengerIds.length > 0
          ? this.identityGrpc
              .call<UsersByIdsReply>('GetUsersByIds', { ids: passengerIds }, meta)
              .catch(() => null)
          : Promise.resolve(null),
        driverIds.length > 0
          ? this.identityGrpc
              .call<DriversByIdsReply>('GetDriversByIds', { ids: driverIds }, meta)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      for (const u of usersReply?.users ?? []) paxNameById.set(u.id, emptyToNull(u.name));
      for (const d of driversReply?.drivers ?? []) drvNameById.set(d.id, emptyToNull(d.name));
    }

    // Enriquecimiento del MODO de despacho (columna MODO) por página, SIN N+1: UN batch gRPC a trip-service
    // (GetTripModesByIds) que lee el `dispatchMode` CONGELADO de la fila (resolve-once-persist, ADR-011) —
    // SIEMPRE exacto, a diferencia del read-model event-proyectado (pierde el flip FIXED→PUJA del re-bid).
    // NO es PII (mecanismo de precio del viaje) → se resuelve para TODOS los roles (fuera del gate canSeeIdentity).
    const modeById = new Map<string, 'FIXED' | 'PUJA' | null>();
    if (page.items.length > 0) {
      const tripIds = [...new Set(page.items.map((r) => r.id).filter((id) => id.length > 0))];
      const modesReply = await this.tripGrpc
        .call<TripModesReply>('GetTripModesByIds', { ids: tripIds }, meta)
        .catch(() => null);
      for (const m of modesReply?.items ?? []) modeById.set(m.id, normalizeDispatchMode(m.dispatchMode));
    }

    return {
      items: page.items.map((r) =>
        tripRecordToSummary(r, roles, {
          passengerName: paxNameById.get(r.passengerId) ?? null,
          driverName: r.driverId ? (drvNameById.get(r.driverId) ?? null) : null,
          dispatchMode: modeById.get(r.id) ?? null,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * MURO DE CÁMARAS EN VIVO (GET /ops/live-cabins · frame "Cámaras en vivo" · T/CameraTile). Lista las cabinas
   * de los viajes EN CURSO enriquecidas con lo que el tile muestra: nombre del conductor, placa, distrito de
   * origen y el reloj de inicio. NO abre el feed (eso exige doble-auth por-viaje en media-bff) — solo describe
   * el tile. Fan-out acotado (el muro tiene pocos viajes activos): GetTrip por viaje (geo+vehículo+inicio
   * autoritativos), luego DOS batches (identity nombres + fleet placas) y reverse-geocode soberano del origen.
   * REDACCIÓN por rol (matriz aprobada): nombre=Compliance+ (sub → null), placa=dispatch+ (SUPPORT →
   * enmascarada), distrito=geo exacta (roles sin geo exacta → null). Degradación honesta: lo ausente → null.
   */
  async listLiveCabins(identity: AuthUser): Promise<LiveCabin[]> {
    const roles = identity.roles;
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    // Viajes activos del read-model (cap del muro: pocas cabinas simultáneas en una central real).
    const page = await this.readModel.listTrips({ status: 'IN_PROGRESS' }, null, 60);
    if (page.items.length === 0) return [];

    // Autoritativo por viaje: GetTrip trae geo de origen (distrito), vehicleId (placa) y requestedAt (reloj).
    // Best-effort en paralelo — un GetTrip caído descarta ESA cabina, no tumba el muro entero.
    const trips = (
      await Promise.all(
        page.items.map((r) =>
          this.tripGrpc.call<TripReply>('GetTrip', { id: r.id }, meta).catch(() => null),
        ),
      )
    ).filter((t): t is TripReply => !!t?.found);
    if (trips.length === 0) return [];

    // DOS batches en paralelo (anti-N+1): nombres (identity, solo si el rol ve PII) + placas (fleet).
    const driverIds = [...new Set(trips.map((t) => t.driverId).filter((id) => id.length > 0))];
    const vehicleIds = [...new Set(trips.map((t) => t.vehicleId).filter((id) => id.length > 0))];
    const identityVisible = canSeeIdentity(roles);
    const [driversReply, vehiclesReply] = await Promise.all([
      identityVisible && driverIds.length > 0
        ? this.identityGrpc
            .call<DriversByIdsReply>('GetDriversByIds', { ids: driverIds }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      vehicleIds.length > 0
        ? this.fleetGrpc
            .call<VehiclesReply>('GetVehiclesByIds', { ids: vehicleIds }, meta)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const nameById = new Map<string, string | null>();
    for (const d of driversReply?.drivers ?? []) nameById.set(d.id, emptyToNull(d.name));
    const plateById = new Map<string, string>();
    for (const v of vehiclesReply?.vehicles ?? []) plateById.set(v.id, v.plate);

    // Distrito de origen (reverse-geocode SOBERANO @veo/maps · self-hosted). MISMA gate que la geo exacta:
    // un rol con geo coarse NO ve el distrito preciso. En paralelo; degradación honesta a null (geocoder/ sin match).
    const geoVisible = canSeeExactTripGeo(roles);
    const districts = await Promise.all(
      trips.map((t) =>
        geoVisible ? this.reverseDistrict(toGeo(t.originLat, t.originLng)) : Promise.resolve(null),
      ),
    );

    return trips.map((t, i) => {
      const rawPlate = t.vehicleId ? (plateById.get(t.vehicleId) ?? null) : null;
      return {
        tripId: t.id,
        driverName: identityVisible ? (nameById.get(t.driverId) ?? null) : null,
        // Placa: dispatch+ la ve completa; SUPPORT la ve enmascarada (misma matriz que el detalle de viaje).
        plate: canSeePlate(roles) ? rawPlate : maskPlate(rawPlate),
        district: districts[i] ?? null,
        status: mapTripStatus(t.status),
        // No hay timestamp de "recogida" en GetTrip → requestedAt es el reloj del viaje (honesto).
        startedAt: t.requestedAt,
      };
    });
  }

  async listDrivers(identity: AuthUser, query: ListDriversQueryDto): Promise<Page<DriverApproval>> {
    const roles = identity.roles;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listDrivers(
      { status: query.status },
      query.cursor ?? null,
      limit,
    );

    // Enriquecimiento por página, SIN N+1: UNA lectura batch a identity (GetDriversByIds). Dos usos del MISMO
    // reply:
    //  1) IDENTIDAD (nombre/teléfono · PII · Ley 29733): SOLO se EXPONE a Compliance+ (el mapper redacta a null
    //     para sub-Compliance). No vive en el read-model (los eventos driver.* no llevan PII) → se resuelve acá.
    //  2) RECONCILIACIÓN DEL BADGE de suspensión (AUTORIDAD: identity, NO el read-model · modelo de HOLDS): el
    //     read-model proyecta el status de EVENTOS de dominio, pero NO ve dos cosas — (a) la suspensión por ITV
    //     llega keyeada por User.id y el consumer NO la proyecta (no tiene el índice inverso userId→driverId),
    //     y (b) la AUTO-reactivación (el conductor regularizó un documento/ITV por su cuenta) quita el hold en
    //     identity SIN emitir `driver.reactivated` (ese evento solo lo emite la reactivación del OPERADOR). En
    //     ambos casos el badge de la LISTA quedaba STALE. `suspendedAt` derivado de identity (≥1 hold ⟺ seteado)
    //     es la VERDAD: reconciliamos el badge contra él (mismo dato que el DETALLE ya lee por gRPC). `suspendedAt`
    //     NO es PII (es un hecho de estado que dispatch+ ya ve en el detalle) → se reconcilia para TODOS los roles.
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const identityVisible = canSeeIdentity(roles);
    let enrichmentById = new Map<string, DriverListEnrichment>();
    if (page.items.length > 0) {
      const ids = page.items.map((r) => r.id);
      // DOS batches EN PARALELO por página (anti-N+1): identity (nombre/badge/verificación) + fleet (docs X/Y).
      // El MISMO `ids` (Driver.id) sirve para ambos: identity keyea por Driver.id, y los docs DRIVER-scoped de
      // fleet por ownerId=Driver.id. El batch de identity ahora trae el ESTADO de verificación (sin descifrar DNI).
      const [reply, docsReply] = await Promise.all([
        this.identityGrpc.call<DriversByIdsReply>('GetDriversByIds', { ids }, meta),
        this.fleetGrpc.call<DriverDocsCompletenessReply>(
          'GetDriverDocsCompleteness',
          { ids },
          meta,
        ),
      ]);
      const docsById = new Map(docsReply.items.map((it) => [it.driverId, it]));
      enrichmentById = new Map(
        reply.drivers.map((d) => {
          const docs = docsById.get(d.id);
          return [
            d.id,
            {
              // PII: solo si el rol la puede ver; si no, null honesto (el reply igual se usa para el badge).
              fullName: identityVisible ? emptyToNull(d.name) : null,
              phone: identityVisible ? emptyToNull(d.phone) : null,
              // Estado AUTORITATIVO de suspensión (derivado de los holds): "" ⇒ libre; ISO ⇒ suspendido.
              suspendedAt: emptyToNull(d.suspendedAt),
              // CAUSAS distintas de los holds (cause-aware UI de reactivación · NO PII): el batch ahora las trae
              // por driver (mismo dato que el detalle). Narrowing defensivo: descarta valores fuera del enum.
              suspensionCauses: toSuspensionCauses(d.suspensionCauses),
              // Completitud documental (fleet · no PII): visible para todos los roles que ven la lista.
              docsComplete: docs?.validRequired ?? 0,
              docsTotal: docs?.requiredTotal ?? REQUIRED_DRIVER_DOC_TYPES.length,
              // Verificación biométrica combinada. Señal del proceso KYC (ADMIN/Compliance+) → null para
              // sub-Compliance (mismo criterio de redacción que nombre/teléfono).
              verificationStatus: identityVisible ? deriveVerificationStatus(d) : null,
              // Presencia OPERATIVA autoritativa (identity.currentStatus). La columna ESTADO debe mostrar
              // presencia (En línea/Offline), NO el `status` de ciclo de vida del read-model (PENDING/ACTIVE/…)
              // que NO es presencia — un postulante PENDING no está "en línea". No es PII (el detalle ya lo
              // expone) → sin gate de rol. "" (proto3 sin dato) → null.
              operationalStatus: emptyToNull(d.currentStatus),
            },
          ];
        }),
      );
    }

    return {
      items: page.items.map((r) => driverRecordToApproval(r, roles, enrichmentById.get(r.id))),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Detalle de viaje al contrato PLANO `tripDetail` (@veo/api-client). Enriquece con datos REALES del
   * fan-out gRPC: createdAt←requestedAt, origin/destination de coords, nombres de identity, placa de
   * fleet, y ruta planeada + ETA (viaje VIVO) vía la facade soberana @veo/maps (ver plannedRoute). Lo
   * que sigue sin fuente (ubicación EN VIVO del conductor — tracking-service —, timeline de eventos)
   * va `null`/`[]` honesto — su enriquecimiento es follow-up.
   */
  async tripDetail(identity: AuthUser, tripId: string): Promise<TripDetail> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado', { tripId });

    const [passenger, driver, vehicles] = await Promise.all([
      trip.passengerId
        ? this.identityGrpc
            .call<UserReply>('GetUser', { id: trip.passengerId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      trip.driverId
        ? this.identityGrpc
            .call<DriverReply>('GetDriver', { id: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      // Placa del vehículo del conductor (fleet): best-effort, no debe tumbar el detalle si fleet falla.
      trip.driverId
        ? this.fleetGrpc
            .call<DriverVehiclesReply>('GetDriverVehicles', { id: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    // Un conductor puede tener varios vehículos: priorizamos el ACTIVO, si no el primero.
    const rawPlate =
      vehicles?.vehicles?.find((v) => v.active)?.plate ?? vehicles?.vehicles?.[0]?.plate ?? null;

    // REDACCIÓN PII (server-side, matriz aprobada): identidad=Compliance+, placa=dispatch+ (SUPPORT
    // → enmascarada), geo de viaje=dispatch+ (SUPPORT → coarse ~100m). Montos (fareCents) NO se
    // redactan acá: el contrato lo declara `number` no-nullable → diferido (ver mappers.ts + reporte).
    const roles = identity.roles;
    const passengerName = passenger?.found ? passenger.name || null : null;
    const driverName = driver?.found ? driver.name || null : null;
    const origin = toGeo(trip.originLat, trip.originLng);
    const destination = toGeo(trip.destinationLat, trip.destinationLng);
    const status = mapTripStatus(trip.status);

    // Ruta del viaje. GetTrip YA expone la polyline PERSISTIDA (Trip.routePolyline, congelada al crear)
    // — pero hoy nace null: trip-service rutea con el motor local (VEO_MAPS_MODE=local, sin calles).
    // Boundary elegido: trip-service es dueño de los PUNTOS del viaje (origin/destination/waypoints, ya
    // en GetTrip); el TRAZADO es derivable y lo resuelve ESTE bff con su facade soberana @veo/maps
    // (mismo patrón que driver-bff trips.route()), cacheado en el facade (las rutas son estables).
    // Solo para viaje VIVO: la persistida (dato propio del viaje) manda si existe; la computada es el
    // fallback. Para un TERMINAL solo se expone la persistida — fabricar una ruta on-the-fly ahí se
    // leería como el recorrido REAL que hizo el conductor, y eso es inventar (criterio de ops/audit).
    // Sin posición viva del conductor (tracking-service es follow-up): ruta y ETA son de la ruta
    // PLANEADA origen→paradas→destino, no del tramo restante.
    const persistedPolyline = trip.routePolyline || null;
    const planned =
      isLiveAdminTrip(status) && origin && destination
        ? await this.plannedRoute(origin, destination, trip.waypoints)
        : null;
    const routePolyline = persistedPolyline ?? planned?.polyline ?? null;
    // ETA estimada al destino (duración de la ruta planeada; null en terminales — la UI ya lo gatea).
    const etaSeconds = planned?.durationSeconds ?? null;

    // Reverse-geocode SOBERANO (@veo/maps · self-hosted, jamás Google) origin/destino → dirección legible.
    // MISMA gate de redacción que la geo: solo los roles que ven la geo EXACTA (canSeeExactTripGeo) reciben el
    // label de calle — un rol con geo coarse NO debe ver la dirección precisa (el label la revelaría). En
    // PARALELO (2 reverses). Degradación HONESTA: geocoder caído / sin match → null (el front muestra las coords).
    const [originLabel, destinationLabel] = canSeeExactTripGeo(roles)
      ? await Promise.all([this.reverseLabel(origin), this.reverseLabel(destination)])
      : [null, null];

    return {
      id: trip.id,
      status,
      passengerId: trip.passengerId,
      driverId: trip.driverId || null,
      fareCents: trip.fareCents,
      createdAt: trip.requestedAt,
      // Modo de despacho CONGELADO del viaje (FIXED|PUJA); '' (no hallado) o fuera del set → null honesto.
      dispatchMode: normalizeDispatchMode(trip.dispatchMode),
      origin: canSeeExactTripGeo(roles) ? origin : coarseGeo(origin),
      destination: canSeeExactTripGeo(roles) ? destination : coarseGeo(destination),
      // Direcciones legibles (reverse-geocode soberano); null para roles sin geo exacta o si no hubo match.
      originLabel,
      destinationLabel,
      driverLocation: null, // dato EN VIVO (tracking-service), no en GetTrip
      // REDACCIÓN: la polyline revela el RECORRIDO exacto → misma gate que la geo precisa (un rol con
      // geo coarse la reconstruiría decodificándola). La ETA es un escalar (no geo) → sin gate.
      routePolyline: canSeeExactTripGeo(roles) ? routePolyline : null,
      etaSeconds,
      // Duración REAL del viaje (Trip.durationSeconds persistido) → KPI "Duración" del detalle. 0 → null honesto.
      durationSeconds: trip.durationSeconds || null,
      distanceMeters: trip.distanceMeters || null,
      passengerName: canSeeIdentity(roles) ? passengerName : null,
      driverName: canSeeIdentity(roles) ? driverName : null,
      // Fecha de suspensión del conductor (proto DriverReply.suspendedAt; '' = no suspendido → null).
      driverSuspendedAt: driver?.found ? driver.suspendedAt || null : null,
      vehiclePlate: canSeePlate(roles) ? rawPlate : maskPlate(rawPlate),
      paymentMethod: trip.paymentMethod || null,
      timeline: [], // follow-up: timeline de eventos no expuesta por GetTrip
    };
  }

  /**
   * Ruta PLANEADA del viaje (origen→paradas→destino) por la facade soberana @veo/maps. Best-effort:
   * router caído / sin ruta → null (degradación HONESTA: el detalle cae a los markers sin trazado,
   * nunca tumba el fan-out). polyline ''/duración 0 (motor local sin calles) → null, no dato falso.
   */
  private async plannedRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    waypoints: readonly { lat: number; lon: number }[],
  ): Promise<{ polyline: string | null; durationSeconds: number | null } | null> {
    try {
      const r = await this.maps.route(origin, destination, waypoints);
      return { polyline: r.polyline || null, durationSeconds: r.durationSeconds || null };
    } catch {
      return null;
    }
  }

  /**
   * Reverse-geocodea un punto → dirección legible (`displayName` de @veo/maps). `null` si el punto es null
   * (viaje sin coord), no hay match, o el geocoder falla — degradación HONESTA: nunca inventa una dirección,
   * el front cae a las coordenadas. Soberano: el puerto @veo/maps es self-hosted (local/OSRM+Nominatim).
   */
  private async reverseLabel(point: { lat: number; lon: number } | null): Promise<string | null> {
    if (!point) return null;
    try {
      const r = await this.maps.reverse({ lat: point.lat, lon: point.lon });
      return r?.displayName ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reverse-geocodea un punto → DISTRITO administrativo (`district` de @veo/maps: addressdetails de Nominatim
   * o el dataset local). `null` si el punto es null, no hay match, el geocoder falla o el proveedor no trae el
   * distrito — degradación HONESTA (el tile cae a solo la placa, nunca inventa un distrito). Soberano.
   */
  private async reverseDistrict(point: { lat: number; lon: number } | null): Promise<string | null> {
    if (!point) return null;
    try {
      const r = await this.maps.reverse({ lat: point.lat, lon: point.lon });
      return r?.district ?? null;
    } catch {
      return null;
    }
  }

  // ── Conductores ──

  /**
   * Detalle de revisión de un conductor (GET /ops/drivers/:id): datos core + estado biométrico +
   * documentos con URLs GET firmadas. Fan-out gRPC (identity GetDriver + fleet GetDriverDocuments) en
   * paralelo; por cada doc con archivo, acuña una presigned URL contra media-service. Auditado (Ley
   * 29733: ver PII/documentos del conductor deja traza inmutable). Ruta gateada a Compliance+ (toda esa
   * franja pasa canSeeIdentity → no se enmascara nada acá: el operador ve los datos completos para revisar).
   */
  async driverDetail(identity: AuthUser, driverId: string): Promise<DriverDetail> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const [driver, docs] = await Promise.all([
      this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta),
      this.fleetGrpc.call<DriverDocumentsReply>('GetDriverDocuments', { id: driverId }, meta),
    ]);
    if (!driver.found) throw new NotFoundError('Conductor no encontrado', { driverId });

    // Ficha del VEHÍCULO OPERADO (F2 · C1 — admin valida informado): fleet indexa Vehicle.driverId con el
    // User.id (driver.userId), NO el driverId de perfil → consultamos por userId. Va después de GetDriver
    // porque recién ahí tenemos el userId (un solo round-trip extra, no un loop).
    //
    // SELECTOR AUTORITATIVO ÚNICO: usamos `GetDriverActiveVehicle` — el MISMO `pickActiveVehicle` que evalúa
    // el gate de ITV (GetDriverInspectionStatus), que dispatch consume al adjudicar y que el driver-bff sella
    // en el ping. El display admin reusaba un `find(active) ?? [0]` DIVERGENTE → el operador podía ver un
    // vehículo distinto del que el gate evalúa al aprobar. Una sola definición de "vehículo operado" en TODO
    // el sistema, display incluido. `found=false` (proto3 default) ⇒ ningún vehículo operable → null.
    const activeVehicle = await this.fleetGrpc.call<VehicleReply>(
      'GetDriverActiveVehicle',
      { id: driver.userId },
      meta,
    );
    const vehicle: DriverVehicle | null = activeVehicle.found
      ? {
          id: activeVehicle.id,
          plate: activeVehicle.plate,
          make: activeVehicle.make,
          model: activeVehicle.model,
          year: activeVehicle.year,
          color: activeVehicle.color,
          vehicleType: activeVehicle.vehicleType,
          docStatus: activeVehicle.docStatus,
          active: activeVehicle.active,
        }
      : null;

    // Sub-lote 3A · MÚLTIPLES imágenes por documento: por cada doc, acuñamos una presigned GET URL POR
    // IMAGEN (DNI anverso+reverso, N fotos de vehículo). Backward-compat: si el doc NO trae imágenes pero
    // sí el legacy fileS3Key, lo tratamos como una sola imagen SINGLE (no se pierde el render de 1 imagen).
    // `url` (deprecado) = la URL de la primera imagen, para el render legacy. Todas las firmas en paralelo.
    // READINESS de aprobación (docs + ITV) REFLEJADO del gate server-side, en paralelo con el presigning de
    // imágenes (1 gRPC extra, sin latencia añadida): el panel muestra qué falta y NO habilita aprobar a ciegas.
    const approvalReadinessPromise = this.computeApprovalGates(identity, driver.userId, docs);
    const documents: AdminDriverDocument[] = await Promise.all(
      docs.documents.map(async (doc) => {
        // Fuente de imágenes: las N reales o, si no hay, la degradación al legacy fileS3Key (1 SINGLE).
        const rawImages: { s3Key: string; side: string; order: number }[] =
          doc.images && doc.images.length > 0
            ? doc.images
            : doc.fileS3Key
              ? [{ s3Key: doc.fileS3Key, side: DocumentSide.SINGLE, order: 0 }]
              : [];

        const images: AdminDocumentImage[] = await Promise.all(
          rawImages.map(async (img) => ({
            side: toDocumentSide(img.side),
            order: img.order,
            url: await this.presignDocument(identity, img.s3Key),
          })),
        );

        return {
          id: doc.id,
          type: doc.type as AdminDriverDocument['type'],
          status: doc.status as AdminDriverDocument['status'],
          expiresAt: emptyToNull(doc.expiresAt),
          rejectionReason: emptyToNull(doc.rejectionReason),
          // DEPRECADO: URL de la primera imagen (backward-compat con el render de 1 imagen).
          url: images[0]?.url ?? null,
          images,
        };
      }),
    );

    const approvalReadiness = await approvalReadinessPromise;

    await this.audit.record(identity, {
      action: 'driver.documents.view',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { documentCount: documents.length },
    });

    return {
      id: driver.id,
      userId: driver.userId,
      fullName: emptyToNull(driver.name),
      phone: emptyToNull(driver.phone),
      licenseNumber: emptyToNull(driver.licenseNumber),
      dni: emptyToNull(driver.documentId),
      birthDate: emptyToNull(driver.birthDate),
      backgroundCheckStatus: driver.backgroundCheckStatus,
      kycStatus: driver.kycStatus,
      currentStatus: driver.currentStatus,
      // createdAt es no-nullable en el contrato; proto3 entrega "" si no hay dato → degradación honesta a "".
      createdAt: driver.createdAt,
      rejectionReason: emptyToNull(driver.rejectionReason),
      biometric: {
        faceEnrolledAt: emptyToNull(driver.faceEnrolledAt),
        lastVerifiedAt: emptyToNull(driver.lastVerifiedAt),
        // Sub-lote 3C · BINDING DNI↔selfie GUARDADO (lo corre identity, acá solo se EXPONE para que el
        // operador lo VEA junto a la biometría antes de aprobar). El status viene tipado de identity
        // (NOT_RUN/MATCHED/NO_MATCH · narrowing defensivo a NOT_RUN ante un valor desconocido del wire).
        dniFaceMatchStatus: toDniFaceMatchStatus(driver.dniFaceMatchStatus),
        dniFaceMatchScore: driver.dniFaceMatchedAt ? driver.dniFaceMatchScore : null,
        dniFaceMatchedAt: emptyToNull(driver.dniFaceMatchedAt),
        // Lote C · BINDING licencia↔selfie GUARDADO (gemelo del DNI · binding MÁS FUERTE). Mismo narrowing y
        // gateo de score por "se corrió" (licenseFaceMatchedAt) que el DNI. El operador VE ambos bindings.
        licenseFaceMatchStatus: toDniFaceMatchStatus(driver.licenseFaceMatchStatus),
        licenseFaceMatchScore: driver.licenseFaceMatchedAt ? driver.licenseFaceMatchScore : null,
        licenseFaceMatchedAt: emptyToNull(driver.licenseFaceMatchedAt),
        // F5 · presigned GET de la SELFIE del enrol (ayuda visual del operador en casos dudosos). TTL corto,
        // Compliance+ (la gateaba ya el roster de la ruta). `null` si no hay selfie (best-effort no la guardó)
        // o si la firma falla (fail-soft). El operador la VE junto al score; el match sigue siendo la verificación.
        faceSelfieUrl: driver.faceSelfieKey
          ? await this.presignDocument(identity, driver.faceSelfieKey)
          : null,
        // LIVENESS PASIVO del enrol (anti-spoofing PAD). identity lo persiste + lo deriva; acá se EXPONE para que
        // el operador VEA si la selfie pasó el anti-spoofing antes de aprobar. Status tipado (narrowing defensivo
        // a NOT_RUN ante un valor desconocido del wire). El score (0..1) se gatea por "se corrió" (status !=
        // NOT_RUN), igual que el score de los face-match se gatea por su `*MatchedAt`.
        livenessStatus: toPassiveLivenessStatus(driver.livenessStatus),
        livenessScore:
          toPassiveLivenessStatus(driver.livenessStatus) === PassiveLivenessStatus.NOT_RUN
            ? null
            : driver.livenessScore,
      },
      vehicle,
      documents,
      // CAUSAS de suspensión (modelo de HOLDS · derivado en identity): el panel las usa para llamar el
      // endpoint correcto de reactivación (DISCIPLINARY → /reactivate; DOCUMENT_EXPIRED/INSPECTION_EXPIRED →
      // /reactivate-compliance). [] si no está suspendido. Defensivo: proto3 puede entregar el repeated como
      // undefined si el productor es viejo → degradamos a [] (el badge `currentStatus`/suspensión no cambia).
      suspensionCauses: driver.suspensionCauses ?? [],
      approvalReadiness,
    };
  }

  /**
   * Gates de aprobación NO-biométricos (documental + ITV) calculados UNA vez — FUENTE ÚNICA consumida por:
   *  - `approveDriver` → los IMPONE (fail-closed; curl-proof: saltear la UI no saltea el gate).
   *  - `driverDetail`  → los EXPONE como `approvalReadiness` para que el panel muestre QUÉ falta y NO habilite
   *    "Aprobar" a ciegas (la UI refleja, NO autoriza).
   * Recibe los `docs` YA traídos (evita un GetDriverDocuments duplicado) y suma la inspección del vehículo
   * OPERADO. fleet indexa los vehículos por Vehicle.driverId = User.id → la ITV se consulta por `userId`, NO
   * el driverId de perfil (mismo patrón que driverDetail/approveDriver).
   */
  /**
   * Documentos REQUERIDOS que faltan (no presentes en estado VALID). FUENTE ÚNICA del check documental —
   * consumida por `computeApprovalGates` (gate de approve) y por el gate de INICIO de verificación en
   * `runDniFaceMatch`/`runLicenseFaceMatch`. Puro sobre los `docs` YA traídos (no hace I/O).
   */
  private missingRequiredDocs(docs: DriverDocumentsReply): FleetDocumentType[] {
    return REQUIRED_DRIVER_DOC_TYPES.filter(
      (req) =>
        !docs.documents.some((d) => d.type === req && d.status === FleetDocumentStatus.VALID),
    );
  }

  /**
   * GATE DE INICIO DE VERIFICACIÓN (#2): el conductor debe tener SUBIDOS todos los documentos requeridos antes
   * de que el operador pueda verificar su identidad (face-match). Es un BLOQUEO, NO un rechazo — si falta subir
   * algún documento, el operador no puede empezar y el conductor queda esperando en su onboarding (nunca se lo
   * auto-rechaza: REJECTED es decisión humana real, no "no terminó de subir").
   *
   * Chequea PRESENCIA (documento subido, cualquier estado), NO VALID: la VALIDACIÓN de cada doc + el face-match
   * son parte de la MISMA revisión del operador (exigir LICENSE_A1=VALID antes de su propio face-match sería
   * circular). El gate DURO de VALID lo aplica approve() al final (computeApprovalGates). Progresión: subir todo
   * → operador revisa+verifica → operador aprueba (exige VALID).
   */
  private assertDocumentsComplete(driverId: string, docs: DriverDocumentsReply): void {
    const notUploaded = REQUIRED_DRIVER_DOC_TYPES.filter(
      (req) => !docs.documents.some((d) => d.type === req),
    );
    if (notUploaded.length > 0) {
      throw new ConflictError(
        `No se puede iniciar la verificación: el conductor debe SUBIR todos sus documentos primero. Faltan: ${notUploaded.join(', ')}`,
        { driverId, missing: notUploaded },
      );
    }
  }

  private async computeApprovalGates(
    identity: AuthUser,
    userId: string,
    docs: DriverDocumentsReply,
  ): Promise<DriverDetail['approvalReadiness']> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const inspection = await this.fleetGrpc.call<DriverInspectionStatusReply>(
      'GetDriverInspectionStatus',
      { id: userId },
      meta,
    );
    const missingDocuments = this.missingRequiredDocs(docs);
    return {
      documentsValid: missingDocuments.length === 0,
      missingDocuments: [...missingDocuments],
      inspection: {
        current: inspection.current,
        invalidReason: emptyToNull(inspection.invalidReason),
        nextDueAt: emptyToNull(inspection.nextDueAt),
        hasVehicle: inspection.hasVehicle,
        vehicleId: emptyToNull(inspection.vehicleId),
      },
    };
  }

  /**
   * Sub-lote 3C · ORQUESTA el face-match DNI↔selfie (POST /ops/drivers/:id/dni-face-match). Pasos:
   *   1) Trae los documentos del conductor (gRPC GetDriverDocuments) y ubica el DNI → su imagen FRONT
   *      (sub-lote 3A: DocumentImage con side=FRONT). El admin NO inventa la imagen: sale del documento
   *      REAL que el conductor subió a S3.
   *   2) Baja los BYTES del binario de S3 vía la MISMA presigned GET URL que usa el DocumentViewer, y los
   *      codifica a base64.
   *   3) Llama al identity `POST /drivers/:id/dni-face-match { image }`. identity usa el `faceEmbedding`
   *      GUARDADO del conductor (server-truth, NO uno del caller), corre el match, lo GUARDA y lo devuelve.
   *   4) Devuelve el resultado al panel + lo audita (Ley 29733: correr una verificación biométrica deja traza).
   *
   * GARANTÍA DE SEGURIDAD: la imagen sale del DNI real (S3, no arbitraria) y el embedding de referencia es el
   * GUARDADO del conductor (lo resuelve identity, el caller no lo manda). El admin-bff solo transporta los
   * bytes del DNI; nunca elige la biometría contra la que se cotea.
   */
  async runDniFaceMatch(identity: AuthUser, driverId: string): Promise<DniFaceMatchResult> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
    // #2 — docs completos ANTES de verificar (BLOQUEO, no rechazo): el operador no arranca el face-match si
    // falta algún documento requerido. El conductor completa todo primero; recién ahí el humano verifica.
    this.assertDocumentsComplete(driverId, docs);
    // Ubica el DNI y su imagen FRONT (sub-lote 3A). Sin DNI / sin FRONT → 409 honesto: no hay foto que cotear.
    const dni = docs.documents.find((d) => d.type === FleetDocumentType.DNI);
    const frontKey =
      dni?.images?.find((img) => img.side === DocumentSide.FRONT)?.s3Key ??
      // Backward-compat: un DNI legacy con una sola imagen (fileS3Key) se trata como el FRONT.
      (dni?.fileS3Key || null);
    if (!frontKey) {
      throw new ConflictError(
        'No se puede verificar el rostro: el conductor no tiene la foto FRONT del DNI cargada',
        { driverId },
      );
    }

    // Baja los bytes del DNI de S3 (misma presigned GET que el visor) y los codifica a base64.
    const image = await this.fetchDocumentImageBase64(identity, frontKey);
    if (!image) {
      throw new ConflictError('No se pudo descargar la imagen del DNI para la verificación', {
        driverId,
      });
    }

    const result = await this.identityRest.post<DniFaceMatchResult>(
      `/drivers/${driverId}/dni-face-match`,
      { identity, body: { image } },
    );
    await this.audit.record(identity, {
      action: 'driver.dni-face-match',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { matched: result.matched, score: result.score },
    });
    return result;
  }

  /**
   * Lote C · ORQUESTA el face-match licencia↔selfie (POST /ops/drivers/:id/license-face-match). Gemelo de
   * `runDniFaceMatch`: ubica el brevete (LICENSE_A1) → su imagen FRONT (donde va la foto del titular) → baja
   * los bytes de S3 → los pasa a identity `POST /drivers/:id/license-face-match { image }`. identity coteja
   * contra el `faceEmbedding` GUARDADO (server-truth), lo persiste y lo devuelve. Audita (Ley 29733).
   *
   * MISMA GARANTÍA que el DNI: la imagen sale del brevete REAL (S3, no arbitraria) y el embedding de
   * referencia es el GUARDADO del conductor (lo resuelve identity). El admin-bff solo transporta los bytes.
   */
  async runLicenseFaceMatch(identity: AuthUser, driverId: string): Promise<DniFaceMatchResult> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
    // #2 — docs completos ANTES de verificar (BLOQUEO, no rechazo; gemelo del gate en runDniFaceMatch).
    this.assertDocumentsComplete(driverId, docs);
    // Ubica el brevete (LICENSE_A1) y su imagen FRONT (la cara con la foto del titular). Sin licencia / sin
    // FRONT → 409 honesto: no hay foto que cotear.
    const license = docs.documents.find((d) => d.type === FleetDocumentType.LICENSE_A1);
    const frontKey =
      license?.images?.find((img) => img.side === DocumentSide.FRONT)?.s3Key ??
      // Backward-compat: un brevete legacy con una sola imagen (fileS3Key) se trata como el FRONT.
      (license?.fileS3Key || null);
    if (!frontKey) {
      throw new ConflictError(
        'No se puede verificar el rostro: el conductor no tiene la foto del brevete (licencia) cargada',
        { driverId },
      );
    }

    const image = await this.fetchDocumentImageBase64(identity, frontKey);
    if (!image) {
      throw new ConflictError('No se pudo descargar la imagen del brevete para la verificación', {
        driverId,
      });
    }

    const result = await this.identityRest.post<DniFaceMatchResult>(
      `/drivers/${driverId}/license-face-match`,
      { identity, body: { image } },
    );
    await this.audit.record(identity, {
      action: 'driver.license-face-match',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { matched: result.matched, score: result.score },
    });
    return result;
  }

  /**
   * Baja los BYTES de un binario de S3 (vía la presigned GET de media) y los codifica a base64. Reusa
   * `presignDocument` (server-to-server, TTL corto). Devuelve null si no se pudo firmar o descargar
   * (degradación honesta — el caller lo traduce a un 409 claro, no a un 500 opaco).
   */
  private async fetchDocumentImageBase64(
    identity: AuthUser,
    fileS3Key: string,
  ): Promise<string | null> {
    const url = await this.presignDocument(identity, fileS3Key);
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Acuña una presigned GET URL para el archivo de un documento (media-service, server-to-server).
   * fileS3Key '' (sin archivo subido aún) → null. FAIL-SOFT: si la firma falla, devolvemos null y
   * seguimos — una clave inválida NO debe tumbar toda la pantalla de revisión (la decisión de aprobar
   * NO depende de poder ver el archivo; el gate de aprobación valida el ESTADO del doc, no su URL).
   */
  private async presignDocument(identity: AuthUser, fileS3Key: string): Promise<string | null> {
    if (!fileS3Key) return null;
    try {
      const { url } = await this.mediaRest.post<{ url: string }>('/media/internal/presign-get', {
        identity,
        body: { bucket: this.documentsBucket, key: fileS3Key, ttlSeconds: 120 },
      });
      return url;
    } catch {
      return null;
    }
  }

  async listPendingDrivers(identity: AuthUser): Promise<PendingDriver[]> {
    // identity devuelve legalName (el nombre del onboarding); lo exponemos como fullName para que la
    // cola muestre QUIÉN es el conductor, no un UUID.
    const raw = await this.identityRest.get<
      { id: string; userId: string; licenseNumber: string | null; legalName: string | null }[]
    >('/drivers/pending-approval', { identity });
    const identityVisible = canSeeIdentity(identity.roles);
    // Enriquecimiento del EMBUDO (docs X/Y + verificación) para que la cola de pendientes se filtre y muestre
    // como el frame (tabs Sin docs / Listos / En revisión). DOS batches en paralelo, keyeados por Driver.id.
    let docsById = new Map<string, { validRequired: number; requiredTotal: number }>();
    let verifById = new Map<string, VerificationStatus>();
    let createdAtById = new Map<string, string | null>();
    const ids = raw.map((d) => d.id);
    if (ids.length > 0) {
      const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
      const [docsReply, driversReply] = await Promise.all([
        this.fleetGrpc.call<DriverDocsCompletenessReply>(
          'GetDriverDocsCompleteness',
          { ids },
          meta,
        ),
        this.identityGrpc.call<DriversByIdsReply>('GetDriversByIds', { ids }, meta),
      ]);
      docsById = new Map(docsReply.items.map((it) => [it.driverId, it]));
      verifById = new Map(driversReply.drivers.map((d) => [d.id, deriveVerificationStatus(d)]));
      // Aging para la cola de Revisiones: alta del conductor (createdAt) = momento de encolado. "" ⇒ null honesto.
      createdAtById = new Map(driversReply.drivers.map((d) => [d.id, emptyToNull(d.createdAt)]));
    }
    return raw.map((d) => {
      const docs = docsById.get(d.id);
      return {
        id: d.id,
        userId: d.userId,
        // licenseNumber (DNI/licencia) = IDENTIDAD personal → Compliance+. Sub-Compliance: null honesto.
        licenseNumber: identityVisible ? d.licenseNumber : null,
        fullName: emptyToNull(d.legalName ?? ''),
        docsComplete: docs?.validRequired ?? 0,
        docsTotal: docs?.requiredTotal ?? REQUIRED_DRIVER_DOC_TYPES.length,
        // Verificación (señal KYC · Compliance+): null para sub-Compliance (redacción como el DNI/nombre).
        verificationStatus: identityVisible ? (verifById.get(d.id) ?? 'PENDIENTE') : null,
        // Momento de encolado (alta) para el SLA/orden de la cola de Revisiones. null si identity no lo trae.
        enqueuedAt: createdAtById.get(d.id) ?? null,
      };
    });
  }

  /**
   * Conteo de conductores por estado de antecedentes (embudo de aprobación · stat cards del panel). UN gRPC a
   * identity (GetDriverCounts · groupBy agregado, sin traer filas); sin PII (solo enteros). Riel ADMIN. El
   * reply gRPC (DriverCountsReply) es estructuralmente el contrato DriverCounts que expone el BFF.
   */
  async driversSummary(identity: AuthUser): Promise<DriverCounts> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    // cleared/rejected (agregado de identity) + los ids de PENDIENTES (cola acotada de identity) EN PARALELO.
    const [counts, pendingRaw] = await Promise.all([
      this.identityGrpc.call<DriverCountsReply>('GetDriverCounts', {}, meta),
      this.identityRest.get<{ id: string }[]>('/drivers/pending-approval', { identity }),
    ]);
    // El tramo PENDING se parte en TRES por el embudo de onboarding (frame AdminConductores):
    //  · sinDocs   = le falta ≥1 documento REQUERIDO en VALID.
    //  · listos    = docs completos pero el face-match AÚN NO corrió (PENDIENTE) → listo para que el operador revise.
    //  · enRevision= docs completos y el face-match YA corrió (VERIFICADO/cotejado) → revisión en curso.
    // Dos batches EN PARALELO sobre los ids de la cola de pendientes: fleet (docs) + identity (verificación).
    let sinDocs = 0;
    let listos = 0;
    let enRevision = 0;
    const pendingIds = pendingRaw.map((d) => d.id);
    if (pendingIds.length > 0) {
      const [docsReply, driversReply] = await Promise.all([
        this.fleetGrpc.call<DriverDocsCompletenessReply>(
          'GetDriverDocsCompleteness',
          { ids: pendingIds },
          meta,
        ),
        this.identityGrpc.call<DriversByIdsReply>('GetDriversByIds', { ids: pendingIds }, meta),
      ]);
      const docsById = new Map(docsReply.items.map((it) => [it.driverId, it]));
      const verifById = new Map(
        driversReply.drivers.map((d) => [d.id, deriveVerificationStatus(d)]),
      );
      for (const id of pendingIds) {
        const dc = docsById.get(id);
        const complete = dc ? dc.validRequired >= dc.requiredTotal : false;
        if (!complete) {
          sinDocs += 1;
        } else if (verifById.get(id) === 'PENDIENTE') {
          listos += 1;
        } else {
          enRevision += 1;
        }
      }
    }
    return {
      sinDocs,
      listos,
      enRevision,
      cleared: counts.cleared,
      rejected: counts.rejected,
      // Presencia operativa real (identity.currentStatus agregado) → KPI "En línea" del panel.
      online: counts.online,
    };
  }

  /**
   * Conteo de vehículos por estado documental (embudo de vigencia · stat cards del panel). UN gRPC a fleet
   * (GetVehicleCounts · groupBy agregado por docStatus, sin traer filas); sin PII (solo enteros). El reply gRPC
   * (VehicleCountsReply) es estructuralmente el contrato VehicleCounts que expone el BFF.
   */
  async vehiclesSummary(identity: AuthUser): Promise<VehicleCounts> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    return this.fleetGrpc.call<VehicleCountsReply>('GetVehicleCounts', {}, meta);
  }

  /**
   * Conteo de las COLAS DE REVISIÓN (cola unificada de Revisiones): conductores pendientes de aprobación
   * (identity) + documentos por revisar/por vencer + modelos por curar (fleet). DOS gRPC EN PARALELO (identity
   * GetDriverCounts + fleet GetReviewQueueCounts); el BFF los fusiona en un solo contrato. Sin PII (enteros).
   */
  async reviewsSummary(identity: AuthUser): Promise<ReviewQueueSummary> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const [drivers, fleet] = await Promise.all([
      this.identityGrpc.call<DriverCountsReply>('GetDriverCounts', {}, meta),
      this.fleetGrpc.call<ReviewQueueCountsReply>('GetReviewQueueCounts', {}, meta),
    ]);
    return {
      driversPending: drivers.pending,
      docsPendingReview: fleet.docsPendingReview,
      docsExpiringSoon: fleet.docsExpiringSoon,
      modelsPendingReview: fleet.modelsPendingReview,
    };
  }

  async approveDriver(
    identity: AuthUser,
    driverId: string,
  ): Promise<{ id: string; backgroundCheckStatus: string }> {
    // GATES autoritativos server-side (NO dependen de la UI), AMBOS deben pasar ANTES de delegar a identity:
    //   1) DOCUMENTAL: TODOS los documentos obligatorios existen con estado VALID (Ley 29733).
    //   2) INSPECCIÓN (ITV): el vehículo operado tiene una inspección VIGENTE (passed && no vencida).
    // Es server-side en el flujo de approve → curl-proof: saltearse la UI no saltea los gates.
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
    // fleet indexa los vehículos por Vehicle.driverId = User.id (NO el driverId de perfil) → resolvemos el
    // userId con GetDriver para el gate de ITV. La verdad de docs+ITV la calcula computeApprovalGates (la
    // MISMA que driverDetail EXPONE como approvalReadiness): single source of truth — acá la IMPONEMOS.
    const driver = await this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta);
    if (!driver.found) {
      throw new NotFoundError('Conductor no encontrado', { driverId });
    }
    const gates = await this.computeApprovalGates(identity, driver.userId, docs);
    if (!gates.documentsValid) {
      throw new ConflictError(
        `No se puede aprobar: faltan documentos válidos (${gates.missingDocuments.join(', ')})`,
        { driverId, missing: gates.missingDocuments },
      );
    }
    if (!gates.inspection.current) {
      const message =
        INSPECTION_BLOCK_MESSAGE[gates.inspection.invalidReason ?? ''] ?? INSPECTION_BLOCK_DEFAULT;
      throw new ConflictError(message, {
        driverId,
        userId: driver.userId,
        vehicleId: gates.inspection.vehicleId,
        invalidReason: gates.inspection.invalidReason,
        nextDueAt: gates.inspection.nextDueAt,
        hasVehicle: gates.inspection.hasVehicle,
      });
    }

    const res = await this.identityRest.post<{ id: string; backgroundCheckStatus: string }>(
      `/drivers/${driverId}/approve`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'driver.approve',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { backgroundCheckStatus: res.backgroundCheckStatus },
    });
    return res;
  }

  async rejectDriver(identity: AuthUser, driverId: string, reason?: string): Promise<void> {
    // El motivo (si lo hay) viaja al identity-service, que lo persiste y emite driver.rejected.
    await this.identityRest.post<void>(`/drivers/${driverId}/reject`, {
      identity,
      body: reason ? { reason } : undefined,
    });
    await this.audit.record(identity, {
      action: 'driver.reject',
      resourceType: 'driver',
      resourceId: driverId,
      // El motivo queda en la traza inmutable junto a la decisión (sin motivo ⇒ se omite la clave).
      ...(reason ? { payload: { reason } } : {}),
    });
  }

  /**
   * Destrabe biométrico por la CENTRAL (regla #1 driver: "solo central puede destrabar"). Llama a identity
   * (limpia el lockout de turno + el cooldown de enrol en Redis) y AUDITA el comando del operador (traza
   * inmutable Ley 29733 de quién destrabó a quién). Sin body: la acción es idempotente sobre el driverId.
   */
  async unlockBiometric(identity: AuthUser, driverId: string): Promise<void> {
    await this.identityRest.post<void>(`/drivers/${driverId}/biometric/unlock`, { identity });
    await this.audit.record(identity, {
      action: 'driver.biometric-unlock',
      resourceType: 'driver',
      resourceId: driverId,
    });
  }

  async suspendDriver(identity: AuthUser, driverId: string, reason: string): Promise<void> {
    // El motivo viaja al identity-service, que escribe suspendedAt (CAS idempotente) y emite driver.suspended.
    await this.identityRest.post<void>(`/drivers/${driverId}/suspend`, {
      identity,
      body: { reason },
    });
    await this.audit.record(identity, {
      action: 'driver.suspend',
      resourceType: 'driver',
      resourceId: driverId,
      // El motivo queda en la traza inmutable junto a la decisión del operador (SAFETY).
      payload: { reason },
    });
  }

  async reactivateDriver(identity: AuthUser, driverId: string): Promise<void> {
    // Sin body: identity-service quita SOLO el hold DISCIPLINARY y recomputa `suspendedAt` derivado (modelo de
    // HOLDS), luego emite driver.reactivated. FAIL-CLOSED: identity devuelve 403 si la suspensión era por
    // documentos/ITV vencidos (se levanta por reactivate-compliance, no a mano) y 409 si el conductor no estaba
    // suspendido — el error sube tal cual al panel (no lo enmascaramos).
    await this.identityRest.post<void>(`/drivers/${driverId}/reactivate`, { identity });
    await this.audit.record(identity, {
      action: 'driver.reactivate',
      resourceType: 'driver',
      resourceId: driverId,
    });
  }

  /**
   * OVERRIDE MANUAL del operador para una suspensión por documento/ITV vencido (DOCUMENT_EXPIRED +
   * INSPECTION_EXPIRED · decisión del dueño · compliance/seguridad). Es el HERMANO de `reactivateDriver` (que
   * levanta DISCIPLINARY).
   *
   * UNA SOLA ESCRITURA AUTORITATIVA (modelo de HOLDS): identity `reactivate-compliance` QUITA los holds
   * DOCUMENT_EXPIRED + INSPECTION_EXPIRED y recomputa `Driver.suspendedAt`, todo en UNA tx. Ya NO hay un
   * segundo paso cross-service (antes: limpiar el latch `inspectionSuspendedAt` en fleet) que pudiera fallar
   * y dejar estado inconsistente — el latch fue ELIMINADO con el refactor a holds. Sin latch que limpiar, el
   * override es atómico en el source of truth: el conductor reactivado vuelve a ser RE-suspendible porque el
   * sweeper de ITV re-evalúa cada corrida y re-emite si la ITV sigue vencida (identity dedup-ea por el hold).
   *
   * FAIL-CLOSED: si la suspensión no era de compliance (solo DISCIPLINARY) → 403; si no estaba suspendido →
   * 409. El error sube tal cual al panel (no se enmascara).
   */
  async reactivateDriverForCompliance(identity: AuthUser, driverId: string): Promise<void> {
    // Levanta los holds de compliance (DOCUMENT_EXPIRED + INSPECTION_EXPIRED) en identity, source of truth de
    // la suspensión. UNA escritura autoritativa: sin segundo paso cross-service que pueda fallar.
    await this.identityRest.post<void>(`/drivers/${driverId}/reactivate-compliance`, { identity });

    // audit: traza inmutable del override manual (acción distinta de la reactivación disciplinaria).
    await this.audit.record(identity, {
      action: 'driver.reactivate-compliance',
      resourceType: 'driver',
      resourceId: driverId,
    });
  }

  /**
   * HARD PURGE en cascada de un conductor NO-OPERADO (re-registro). SUPERADMIN + step-up MFA (impuesto por
   * los guards globales del controller). Orden SÍNCRONO con degradación HONESTA:
   *   1) GUARD de historial: trip-service cuenta los viajes del conductor. Si tiene CUALQUIER viaje →
   *      409 ConflictError (tiene historial operativo; va el flujo de olvido BR-S06, no el purge). El
   *      guard corta ANTES de borrar nada — fail-closed: si trip-service no responde, NO se purga.
   *   2) identity purge (Driver + User + auth/biometría/consents en UNA tx). SOURCE OF TRUTH del conductor.
   *      Recibe el driverId y resuelve INTERNAMENTE el userId (user/auth/biometric/consents son por userId).
   *   3) fleet purge (vehículos + documentos del conductor), indexado por el DRIVER id.
   *   4) media purge (binarios S3 bajo drivers/<driverId>/).
   *   5) trip purge (viajes + eventos + propuestas) — dev + preview (`!isProdTier()`).
   *   6) payment purge (5 tablas por driver_id + 4 por user_id) — dev + preview (`!isProdTier()`).
   *   7) read-model removeDriver (saca la proyección Redis de los listados del panel).
   *   8) audit (traza inmutable de la decisión + contadores).
   *
   * INVARIANTE DE ID (la pieza que estaba al revés): `:id` = id de PERFIL Driver de identity (el mismo del
   * trip-count, de approve/reject y de la proyección Redis). Fleet indexa SUS filas por ESTE driverId
   * (`Vehicle.driverId` y `FleetDocument.ownerId` con `ownerType=DRIVER`), y media barre `drivers/<driverId>/`
   * en S3. Por eso fleet y media reciben el DRIVERID, NO el userId. trip indexa por ESTE driverId
   * (`Trip.driverId`); payment indexa 5 tablas por el driverId y 4 por el userId (verificado en DB), por eso
   * recibe AMBOS. El userId lo resuelve identity adentro y nos lo devuelve para el resto del cascade + auditoría.
   *
   * TRIPS/PAYMENTS FUERA DE PROD (dev + preview): en el tier PROD el guard de historial (paso 1) corta ANTES
   * de borrar nada y deriva al derecho al olvido (BR-S06), que ANONIMIZA el dinero (obligación contable) y
   * conserva la traza — NUNCA se hard-borran trips/payments en prod. En dev + preview el superadmin purga data
   * de PRUEBA sin dejar huérfanos. La condición `!isProdTier()` es defensa en profundidad: aunque en el tier
   * prod el guard ya cortó, NO invocamos los purges destructivos de trip/payment en prod.
   *
   * RESILIENCIA DE LA PROYECCIÓN (BUG 3): apenas identity (source of truth) borró el conductor, este NO debe
   * seguir apareciendo en los listados del panel (la lista lee de Redis). Por eso `removeDriver` corre en un
   * `finally`: se ejecuta IGUAL aunque cualquier paso downstream falle aguas abajo. Si hay fallos parciales se
   * acumulan y se reportan (log + summary `partialFailures` + estado del paso), pero la proyección se limpia
   * SIEMPRE — el sistema nunca muestra un conductor ya borrado de identity. La respuesta indica la purga
   * parcial sin mentir "todo borrado".
   */
  async purgeDriver(identity: AuthUser, driverId: string): Promise<DriverPurgeSummary> {
    // 1) GUARD: historial operativo. fail-closed (sin try/catch): si el conteo no se puede obtener,
    // la excepción sube y el purge NO procede — jamás se borra un conductor cuyo historial no pudimos verificar.
    const trips = await this.tripRest.get<DriverTripCountReply>(
      `/internal/drivers/${driverId}/trip-count`,
      { identity },
    );
    // Solo el TIER de PRODUCCIÓN real bloquea si hay historial operativo: el conductor no se hard-borra, va
    // al flujo de olvido (BR-S06) que anonimiza y conserva la traza. En DEV y PREVIEW el superadmin SÍ puede
    // purgar conductores de prueba aunque tengan viajes (data de prueba) — el gate es por TIER (isProdTier),
    // NO por endurecimiento (isHardenedEnv): preview es internet-facing/endurecido pero NO es prod, y ahí
    // queremos probar el purge casi-prod. El cascade en dev+preview SÍ borra trips + payments (pasos 5/6),
    // así no quedan huérfanos. El gate de ROL (@Roles SUPERADMIN) protege en TODOS los tiers.
    // DEUDA: el purge no limpia dispatch.driver_stats · techo: queda una fila de stats huérfana en dev/preview · gatillo: si molesta, endpoint de purge en dispatch
    if (trips.hasTrips && isProdTier()) {
      throw new ConflictError(
        'El conductor tiene historial operativo; usá el flujo de olvido (BR-S06), no el purge',
        { driverId, tripCount: trips.tripCount },
      );
    }

    // 2) identity purge (atómico, SOURCE OF TRUTH). Recibe el driverId; resuelve el userId adentro y nos lo
    //    devuelve sólo para el resumen/auditoría. Si esto falla, sube la excepción y NADA se borró: ok.
    const identityPurge = await this.identityRest.delete<IdentityPurgeReply>(
      `/drivers/${driverId}`,
      {
        identity,
      },
    );
    const { userId } = identityPurge;

    // A partir de acá el conductor YA NO existe en la source of truth. Pase lo que pase aguas abajo, la
    // proyección Redis DEBE limpiarse (finally) para que la lista del panel no muestre un conductor borrado.
    const partialFailures: DriverPurgePartialFailure[] = [];
    let fleet: FleetPurgeReply = { documents: 0, vehicles: 0, vehicleDocuments: 0 };
    let media: MediaPurgeReply = { deleted: 0 };
    // trip/payment: undefined fuera de DEV (no se invocan); se pueblan solo si el cascade DEV corre.
    let trip: TripPurgeReply | undefined;
    let payment: PaymentPurgeReply | undefined;
    let projectionRemoved = false;

    try {
      // 3) fleet purge — fleet indexa cada tabla con un id DISTINTO del mismo conductor (verificado en DB):
      //    documentos de operador por el DRIVER id (FleetDocument ownerType=DRIVER) y vehículos por el
      //    User.id (Vehicle.driverId, que es lo que el driver-bff persistió al registrar). Por eso pasamos
      //    AMBOS: driverId en la ruta + userId en el query. best-effort: un fallo NO debe dejar al conductor
      //    en la lista; se acumula como parcial y la proyección igual se limpia en el finally.
      try {
        fleet = await this.fleetRest.delete<FleetPurgeReply>(`/vehicles/drivers/${driverId}`, {
          identity,
          query: { userId },
        });
      } catch (err) {
        partialFailures.push({ stage: 'fleet', cause: causeOf(err) });
      }

      // 4) media purge — barre los binarios bajo drivers/<driverId>/ del bucket de documentos (S3 los
      //    organiza por el DRIVER id de perfil). Mismo criterio best-effort que fleet.
      try {
        media = await this.mediaRest.delete<MediaPurgeReply>(
          `/media/internal/drivers/${driverId}/documents`,
          { identity, body: { bucket: this.documentsBucket } },
        );
      } catch (err) {
        partialFailures.push({ stage: 'media', cause: causeOf(err) });
      }

      // 5/6) trip + payment purge — dev + preview (NO prod). En el tier de PROD el guard de historial cortó
      //    antes y el dinero se anonimiza por el derecho al olvido (BR-S06), NUNCA se hard-borra. La condición
      //    `!isProdTier()` es defensa en profundidad: aunque en prod el guard ya cortó, no disparamos estos
      //    borrados destructivos en el tier prod. best-effort (mismo criterio que fleet/media): un fallo se
      //    acumula como parcial y la proyección igual se limpia en el finally.
      if (!isProdTier()) {
        // 5) trip purge — viajes del conductor (+ eventos + propuestas), indexados por Trip.driverId = driverId.
        try {
          trip = await this.tripRest.delete<TripPurgeReply>(`/internal/drivers/${driverId}/trips`, {
            identity,
          });
        } catch (err) {
          partialFailures.push({ stage: 'trip', cause: causeOf(err) });
        }

        // 6) payment purge — 5 tablas por driver_id + 4 por user_id (verificado en DB). Pasa AMBOS ids.
        try {
          payment = await this.paymentRest.delete<PaymentPurgeReply>(
            `/internal/drivers/${driverId}/payments`,
            { identity, query: { userId } },
          );
        } catch (err) {
          partialFailures.push({ stage: 'payment', cause: causeOf(err) });
        }
      }
    } finally {
      // 5) read-model: saca la proyección Redis SIEMPRE (incluso si fleet/media fallaron). El dato
      //    autoritativo YA se borró en identity; si Redis fallara, la proyección caduca por TTL y el
      //    listado no resucita el conductor.
      try {
        projectionRemoved = await this.readModel.removeDriver(driverId);
      } catch {
        projectionRemoved = false;
      }
    }

    // 8) audit (traza inmutable: quién purgó a quién y con qué efecto, incluidos los parciales). trip/payment
    //    solo van en el payload si el cascade DEV corrió (en prod quedan undefined → se omiten).
    await this.audit.record(identity, {
      action: 'driver.purge',
      resourceType: 'driver',
      resourceId: driverId,
      payload: {
        userId,
        tripCount: trips.tripCount,
        identity: identityPurge.deleted,
        fleet,
        media,
        ...(trip ? { trip } : {}),
        ...(payment ? { payment } : {}),
        projectionRemoved,
        ...(partialFailures.length > 0 ? { partialFailures } : {}),
      },
    });

    return {
      driverId,
      userId,
      tripCount: trips.tripCount,
      identity: identityPurge.deleted,
      fleet,
      media,
      ...(trip ? { trip } : {}),
      ...(payment ? { payment } : {}),
      projection: { removed: projectionRemoved },
      ...(partialFailures.length > 0 ? { partialFailures } : {}),
    };
  }

  // ── Operadores ──

  listOperators(identity: AuthUser): Promise<OperatorSummary[]> {
    return this.identityRest.get<OperatorSummary[]>('/admin/operators', { identity });
  }

  async createOperator(
    identity: AuthUser,
    email: string,
    roles: AdminRole[],
  ): Promise<CreatedOperator> {
    // Anti-escalada: el actor solo otorga roles de rango ESTRICTAMENTE menor al suyo
    // (excepción: SUPERADMIN→SUPERADMIN). El detalle estructurado va al log/audit, no al body.
    if (!canGrantRoles(identity.roles, roles)) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles: identity.roles,
        requested: roles,
      });
    }
    const res = await this.identityRest.post<CreatedOperator>('/admin/operators', {
      identity,
      body: { email, roles },
    });
    await this.audit.record(identity, {
      action: 'operator.create',
      resourceType: 'admin_user',
      resourceId: res.id,
      payload: { email, roles },
    });
    return res;
  }

  async reinviteOperator(
    identity: AuthUser,
    operatorId: string,
  ): Promise<{ inviteUrl: string; expiresAt: string }> {
    const res = await this.identityRest.post<{ inviteUrl: string; expiresAt: string }>(
      `/admin/operators/${operatorId}/reinvite`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'operator.reinvite',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
    return res;
  }

  async rejectOperator(identity: AuthUser, operatorId: string): Promise<void> {
    await this.identityRest.post<void>(`/admin/operators/${operatorId}/reject`, { identity });
    await this.audit.record(identity, {
      action: 'operator.reject',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
  }

  /**
   * EFFECTIVE PERMISSIONS del operador OBJETIVO derivados de SUS roles con la matriz BASE (`PERMISSION_ROLES`
   * de @veo/policy): un permiso es efectivo si ALGÚN rol del operador lo concede en base. Es per-TARGET, NO
   * per-viewer — el overlay/hidden (capa 2) es del ACTOR que mira, NO del operador mirado; por eso acá se usa
   * la BASE pura (lo que ese operador PUEDE por sus roles), sin restar nada. FUENTE ÚNICA compartida con el
   * front (mismo `PERMISSION_ROLES`), así "qué puede este operador" no diverge entre server y UI.
   */
  private deriveEffectivePermissions(roles: string[]): string[] {
    return PERMISSION_LIST.filter((permission) =>
      roles.some((role) => baseGrants(role, permission)),
    );
  }

  /** Ensambla el `operatorDetail` del contrato: la fila cruda de identity + `effectivePermissions` derivado. */
  private toOperatorDetail(raw: IdentityOperatorDetail): OperatorDetail {
    return {
      id: raw.id,
      email: raw.email,
      name: raw.name ?? null,
      status: raw.status as OperatorDetail['status'],
      roles: raw.roles,
      totpEnrolled: raw.totpEnrolled,
      lastLoginAt: raw.lastLoginAt ?? null,
      createdAt: raw.createdAt,
      effectivePermissions: this.deriveEffectivePermissions(raw.roles),
      sessions: raw.sessions ?? [],
    };
  }

  /**
   * Detalle de un operador (GET /ops/operators/:id): trae el detalle crudo de identity (core + 2FA + último
   * acceso + sesiones) y DERIVA `effectivePermissions` de sus roles (matriz base @veo/policy). Es una LECTURA
   * (no muta) → no audita, igual que `listOperators`.
   */
  async operatorDetail(identity: AuthUser, operatorId: string): Promise<OperatorDetail> {
    const raw = await this.identityRest.get<IdentityOperatorDetail>(
      `/admin/operators/${operatorId}`,
      { identity },
    );
    return this.toOperatorDetail(raw);
  }

  /**
   * Cambia los roles RBAC de un operador (POST /ops/operators/:id/roles). Anti-escalada en el borde del BFF
   * (espejo de createOperator: el actor solo otorga rangos < al suyo) ANTES de tocar identity; identity RE-valida
   * + suma el candado de objetivo + emite `admin.role_changed`. Audita la mutación (Ley 29733). Devuelve el
   * `operatorDetail` actualizado (roles + effectivePermissions recomputados).
   */
  async changeOperatorRoles(
    identity: AuthUser,
    operatorId: string,
    roles: AdminRole[],
  ): Promise<OperatorDetail> {
    if (!canGrantRoles(identity.roles, roles)) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles: identity.roles,
        requested: roles,
      });
    }
    const raw = await this.identityRest.post<IdentityOperatorDetail>(
      `/admin/operators/${operatorId}/roles`,
      { identity, body: { roles } },
    );
    await this.audit.record(identity, {
      action: 'operator.role_change',
      resourceType: 'admin_user',
      resourceId: operatorId,
      payload: { roles },
    });
    return this.toOperatorDetail(raw);
  }

  /** Suspende un operador (POST /ops/operators/:id/suspend → status SUSPENDED). Audita. */
  async suspendOperator(identity: AuthUser, operatorId: string): Promise<void> {
    await this.identityRest.post<IdentityOperatorDetail>(
      `/admin/operators/${operatorId}/suspend`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'operator.suspend',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
  }

  /** Elimina (soft-delete) un operador (POST /ops/operators/:id/remove → deletedAt). Audita. */
  async removeOperator(identity: AuthUser, operatorId: string): Promise<void> {
    await this.identityRest.post<void>(`/admin/operators/${operatorId}/remove`, { identity });
    await this.audit.record(identity, {
      action: 'operator.remove',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
  }

  /** Revoca UNA sesión de un operador (POST /ops/operators/:id/sessions/:sessionId/revoke). Audita. */
  async revokeOperatorSession(
    identity: AuthUser,
    operatorId: string,
    sessionId: string,
  ): Promise<void> {
    await this.identityRest.post<void>(
      `/admin/operators/${operatorId}/sessions/${sessionId}/revoke`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'operator.session.revoke',
      resourceType: 'admin_user',
      resourceId: operatorId,
      payload: { sessionId },
    });
  }
}
