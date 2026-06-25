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
  type UserReply,
  type DriverReply,
  type DriversByIdsReply,
  type DriverVehiclesReply,
  type VehicleReply,
  type DriverDocumentsReply,
  type DriverInspectionStatusReply,
} from '@veo/rpc';
import { ConflictError, ForbiddenError, NotFoundError, isProdTier } from '@veo/utils';
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
  SuspensionCause,
  type AdminRole,
} from '@veo/shared-types';
import type {
  TripSummary,
  DriverApproval,
  TripDetail,
  DriverDetail,
  DriverVehicle,
  AdminDocumentImage,
  AdminDriverDocument,
  DocumentSideValue,
  DniFaceMatchStatusValue,
  DniFaceMatchResult,
  GeoPoint,
} from '@veo/api-client';
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

/** proto3 entrega "" para strings ausentes; el contrato del panel los quiere `null` honesto. */
function emptyToNull(s: string): string | null {
  return s ? s : null;
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
  NO_VEHICLE: 'No se puede aprobar: el conductor no tiene un vehículo operable con inspección técnica (ITV)',
};
const INSPECTION_BLOCK_DEFAULT =
  'No se puede aprobar: inspección técnica (ITV) vencida o ausente';

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
}
export interface OperatorSummary {
  id: string;
  email: string;
  status: string;
  roles: string[];
  createdAt: string;
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
    private readonly readModel: ReadModelService,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
    this.documentsBucket = config.get('S3_BUCKET_DOCUMENTS', { infer: true });
  }

  async listTrips(roles: AdminRole[], query: ListTripsQueryDto): Promise<Page<TripSummary>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listTrips(
      { status: query.status, driverId: query.driverId, passengerId: query.passengerId },
      query.cursor ?? null,
      limit,
    );
    return {
      items: page.items.map((r) => tripRecordToSummary(r, roles)),
      nextCursor: page.nextCursor,
    };
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
      const reply = await this.identityGrpc.call<DriversByIdsReply>(
        'GetDriversByIds',
        { ids: page.items.map((r) => r.id) },
        meta,
      );
      enrichmentById = new Map(
        reply.drivers.map((d) => [
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
          },
        ]),
      );
    }

    return {
      items: page.items.map((r) => driverRecordToApproval(r, roles, enrichmentById.get(r.id))),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Detalle de viaje al contrato PLANO `tripDetail` (@veo/api-client). Enriquece con datos REALES del
   * fan-out gRPC: createdAt←requestedAt, origin/destination de coords, nombres de identity. Lo que GetTrip
   * NO provee (ubicación EN VIVO del conductor, ETA, polilínea de ruta, placa del vehículo, timeline de
   * eventos) va `null`/`[]` honesto — su enriquecimiento (tracking/fleet/trip-events) es follow-up.
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

    return {
      id: trip.id,
      status: mapTripStatus(trip.status),
      passengerId: trip.passengerId,
      driverId: trip.driverId || null,
      fareCents: trip.fareCents,
      createdAt: trip.requestedAt,
      origin: canSeeExactTripGeo(roles) ? origin : coarseGeo(origin),
      destination: canSeeExactTripGeo(roles) ? destination : coarseGeo(destination),
      driverLocation: null, // dato EN VIVO (tracking-service), no en GetTrip
      routePolyline: null, // follow-up: ruta no expuesta por GetTrip
      etaSeconds: null, // dato EN VIVO
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
      },
      vehicle,
      documents,
      // CAUSAS de suspensión (modelo de HOLDS · derivado en identity): el panel las usa para llamar el
      // endpoint correcto de reactivación (DISCIPLINARY → /reactivate; DOCUMENT_EXPIRED/INSPECTION_EXPIRED →
      // /reactivate-compliance). [] si no está suspendido. Defensivo: proto3 puede entregar el repeated como
      // undefined si el productor es viejo → degradamos a [] (el badge `currentStatus`/suspensión no cambia).
      suspensionCauses: driver.suspensionCauses ?? [],
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
  async runDniFaceMatch(
    identity: AuthUser,
    driverId: string,
  ): Promise<DniFaceMatchResult> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
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
  async runLicenseFaceMatch(
    identity: AuthUser,
    driverId: string,
  ): Promise<DniFaceMatchResult> {
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
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
    const list: PendingDriver[] = raw.map((d) => ({
      id: d.id,
      userId: d.userId,
      licenseNumber: d.licenseNumber,
      fullName: emptyToNull(d.legalName ?? ''),
    }));
    // licenseNumber (DNI/licencia) = IDENTIDAD personal → Compliance+. Sub-Compliance: null honesto.
    if (canSeeIdentity(identity.roles)) return list;
    return list.map((d) => ({ ...d, licenseNumber: null }));
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
    const missing = REQUIRED_DRIVER_DOC_TYPES.filter(
      (req) =>
        !docs.documents.some((d) => d.type === req && d.status === FleetDocumentStatus.VALID),
    );
    if (missing.length > 0) {
      throw new ConflictError(
        `No se puede aprobar: faltan documentos válidos (${missing.join(', ')})`,
        { driverId, missing },
      );
    }

    // GATE de INSPECCIÓN TÉCNICA (ITV · compliance/seguridad): un conductor NO se aprueba si su vehículo
    // OPERADO no tiene una inspección VIGENTE (passed && no vencida). Se SUMA al gate documental (no lo
    // reemplaza). La verdad de la ITV es el modelo Inspection en fleet, NO un FleetDocument. fleet indexa
    // los vehículos por Vehicle.driverId = User.id (NO el driverId de perfil), así que primero resolvemos el
    // userId con GetDriver (mismo patrón que driverDetail) y recién con ese userId consultamos la vigencia.
    const driver = await this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta);
    if (!driver.found) {
      throw new NotFoundError('Conductor no encontrado', { driverId });
    }
    const inspection = await this.fleetGrpc.call<DriverInspectionStatusReply>(
      'GetDriverInspectionStatus',
      { id: driver.userId },
      meta,
    );
    if (!inspection.current) {
      const message = INSPECTION_BLOCK_MESSAGE[inspection.invalidReason] ?? INSPECTION_BLOCK_DEFAULT;
      throw new ConflictError(message, {
        driverId,
        userId: driver.userId,
        vehicleId: emptyToNull(inspection.vehicleId),
        invalidReason: inspection.invalidReason || null,
        nextDueAt: emptyToNull(inspection.nextDueAt),
        hasVehicle: inspection.hasVehicle,
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
    const identityPurge = await this.identityRest.delete<IdentityPurgeReply>(`/drivers/${driverId}`, {
      identity,
    });
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
          trip = await this.tripRest.delete<TripPurgeReply>(
            `/internal/drivers/${driverId}/trips`,
            { identity },
          );
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
}
