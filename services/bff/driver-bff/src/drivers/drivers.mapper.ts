/**
 * Agregador puro del perfil del conductor. Sin I/O: combina las respuestas gRPC de
 * identity (driver+user), rating (agregado) y fleet (documentos) en una vista de cumplimiento.
 * Aislado del service para poder testearlo directamente.
 */
import { DocumentSide, DriverStatus, FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import type {
  AggregateReply,
  DriverDocumentsReply,
  DriverReply,
  UserReply,
  VehicleReply,
} from '../common/grpc-replies';
import type {
  DriverDocumentDetail,
  DriverDocumentSimpleStatus,
  DriverDocumentView,
  DriverModelRequestView,
  DriverProfileView,
  DriverVehicleModelView,
  DriverVehicleView,
} from './dto/drivers.dto';
import type { FleetDocumentReply } from '../common/grpc-replies';

/**
 * Tipos de documento que el CONDUCTOR sube en el alta (wizard paso 3) y que componen el gate de
 * presencia/aprobación documental del perfil. Es EXACTAMENTE lo que la app envía
 * (`registrationDocTypeToBackend`): Licencia A1, SOAT y Tarjeta de propiedad.
 *
 * NO incluye:
 *  - `BACKGROUND_CHECK`: NO es un documento que suba el conductor — es una máquina de estados de
 *    identity-service (`driver.backgroundCheckStatus`: PENDING|CLEARED|REJECTED). Su eje vive aparte
 *    en el perfil; mezclarlo acá "perdía" al conductor en el wizard porque nunca existe una fila
 *    FleetDocument de antecedentes.
 *  - `ITV` (Revisión Técnica): documento del VEHÍCULO que gestiona el operador/flota, no parte del
 *    alta del conductor (no está en el wizard).
 */
export const REQUIRED_DRIVER_DOCS: FleetDocumentType[] = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
];

/**
 * El set de requeridos para el alta NUEVA incluye el DNI (documento de identidad del conductor). Se
 * aplica SOLO a conductores que aún están en onboarding (no operativos), para no regresar a los
 * conductores ya aprobados que entraron ANTES de que el DNI fuese requerido (backward-compat).
 * El DNI se sube como documento de 2 caras (FRONT+BACK · sub-lote 3A); su cara FRONT la consume el
 * face-match (sub-lote 3C). Mantener `REQUIRED_DRIVER_DOCS` como base legacy intacta es deliberado:
 * agregar el DNI ahí marcaría retroactivamente a TODO conductor previo como no-compliant.
 */
export const REQUIRED_DRIVER_DOCS_WITH_IDENTITY: FleetDocumentType[] = [
  ...REQUIRED_DRIVER_DOCS,
  FleetDocumentType.DNI,
];

/**
 * Estados de conductor que prueban que YA pasó el onboarding (fue aprobado y operó alguna vez). Para
 * estos NO se exige el DNI retroactivamente (grace de backward-compat). OFFLINE queda EXCLUIDO a
 * propósito: es también el default de identity para un conductor recién creado en pleno onboarding, así
 * que NO prueba que haya sido aprobado. SUSPENDED sí se incluye: fue aprobado en su momento.
 */
const OPERATIONAL_DRIVER_STATUSES: ReadonlySet<DriverStatus> = new Set<DriverStatus>([
  DriverStatus.AVAILABLE,
  DriverStatus.ASSIGNED,
  DriverStatus.ON_TRIP,
  DriverStatus.ON_BREAK,
  DriverStatus.SUSPENDED,
]);

/** Un documento está APROBADO/vigente si está VALID o por vencer (EXPIRING_SOON). */
function isDocApproved(status: string): boolean {
  return status === FleetDocumentStatus.VALID || status === FleetDocumentStatus.EXPIRING_SOON;
}

/** Un documento fue REENVIADO (existe), independientemente de si está aprobado o no. */
function isDocSubmitted(status: string): boolean {
  // Cualquier estado del enum (PENDING_REVIEW/VALID/EXPIRING_SOON/EXPIRED/REJECTED) implica que el
  // conductor YA subió ese documento. La presencia de la fila es la señal de "enviado".
  return status.length > 0;
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

/**
 * Mapea el estado crudo de fleet (VALID/EXPIRING_SOON/EXPIRED/PENDING_REVIEW/REJECTED) al estado
 * simple que muestra la app del conductor (vigente/por_vencer/vencido/en_revision/rechazado).
 */
export function toSimpleDocStatus(status: string): DriverDocumentSimpleStatus {
  switch (status) {
    case FleetDocumentStatus.VALID:
      return 'vigente';
    case FleetDocumentStatus.EXPIRING_SOON:
      return 'por_vencer';
    case FleetDocumentStatus.EXPIRED:
      return 'vencido';
    case FleetDocumentStatus.REJECTED:
      return 'rechazado';
    default:
      // PENDING_REVIEW (o cualquier estado desconocido) → en revisión.
      return 'en_revision';
  }
}

/** Espejo de los valores de DocumentSide para narrowear el string del wire gRPC sin `as` ciego. */
const DOCUMENT_SIDE_VALUES = new Set<string>(Object.values(DocumentSide));

/** Narrowea el `side` string del wire al enum tipado; descarta valores desconocidos (degradación honesta). */
function toDocumentSide(side: string): DocumentSide | null {
  return DOCUMENT_SIDE_VALUES.has(side) ? (side as DocumentSide) : null;
}

/**
 * Cara del documento CON su key S3 interna — paso INTERMEDIO server-side. El mapper es puro (sin I/O) y
 * NO puede firmar la URL: deja pasar `s3Key` para que el service (que tiene el cliente de media) acuñe la
 * presigned GET y construya la `DriverDocumentImageView` final (que ya NO lleva `s3Key`, solo `url`).
 */
export interface DriverDocumentImageWithKey {
  side: DocumentSide;
  order: number;
  s3Key: string;
}

/**
 * Vista detallada de un documento del conductor en su paso INTERMEDIO: idéntica a `DriverDocumentDetail`
 * salvo que sus imágenes aún llevan la key S3 (`DriverDocumentImageWithKey`) en vez de la `url` firmada.
 * El service la transforma en `DriverDocumentDetail` tras firmar cada cara (`presignDriverDocumentImages`).
 */
export type DriverDocumentDetailWithKeys = Omit<DriverDocumentDetail, 'images'> & {
  images: DriverDocumentImageWithKey[];
};

/**
 * Vista detallada de un documento del conductor (paso INTERMEDIO, CON keys S3). Antes este mapper DROPEABA
 * la key (proyectaba solo side+order); ahora la deja pasar para que el service firme la presigned GET por
 * cara (resume del onboarding: re-render server-side sin cachear PII). La key NUNCA llega al cliente.
 */
export function buildDriverDocument(d: FleetDocumentReply): DriverDocumentDetailWithKeys {
  return {
    type: d.type,
    documentNumber: emptyToNull(d.documentNumber) ?? '',
    status: d.status,
    simpleStatus: toSimpleDocStatus(d.status),
    expiresAt: emptyToNull(d.expiresAt),
    ok: isDocApproved(d.status),
    // M5: el motivo del rechazo viaja al conductor ("" del proto3 → null honesto).
    rejectionReason: emptyToNull(d.rejectionReason),
    // Sub-lote 3A: las caras (side + order + s3Key INTERNA). proto3 entrega [] si no hay imágenes.
    images: (d.images ?? [])
      .map((img) => {
        const side = toDocumentSide(img.side);
        return side ? { side, order: img.order, s3Key: img.s3Key } : null;
      })
      .filter((img): img is DriverDocumentImageWithKey => img !== null),
  };
}

/** Vista detallada de los documentos del conductor (paso INTERMEDIO, CON keys S3). */
export function buildDriverDocuments(docs: FleetDocumentReply[]): DriverDocumentDetailWithKeys[] {
  return docs.map(buildDriverDocument);
}

/**
 * Respuesta REST del alta self-service de fleet (POST /api/v1/drivers/vehicles). Subconjunto del
 * vehículo + estado de revisión derivado. Se declara aquí para no acoplar al fleet-service.
 */
export interface FleetDriverVehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: string;
  docStatus: string;
  status: string;
}

/** Mapea el alta REST de fleet a la vista del vehículo del conductor (mapeo explícito). */
export function buildDriverVehicleFromRest(v: FleetDriverVehicleReply): DriverVehicleView {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    vehicleType: v.vehicleType,
    status: v.status,
    docStatus: v.docStatus,
  };
}

/** Mapea un VehicleReply (gRPC GetDriverVehicles) a la vista del vehículo del conductor. */
export function buildDriverVehicleFromGrpc(v: VehicleReply): DriverVehicleView {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    vehicleType: v.vehicleType,
    status: v.status,
    docStatus: v.docStatus,
  };
}

/** Mapea la lista de vehículos del conductor (GET /drivers/vehicles). */
export function buildDriverVehicles(vehicles: VehicleReply[]): DriverVehicleView[] {
  return vehicles.map(buildDriverVehicleFromGrpc);
}

/**
 * Respuesta REST de fleet GET /api/v1/vehicle-models (catálogo curado, paginado por cursor). Se declara
 * aquí para no acoplar al fleet-service. La app no pagina el catálogo (es chico); el BFF pide una página
 * amplia y devuelve sus items.
 */
export interface FleetVehicleModelReply {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  vehicleType: string;
  seats: number;
}
export interface FleetVehicleModelPageReply {
  items: FleetVehicleModelReply[];
  nextCursor: string | null;
}

/** Mapea un modelo del catálogo de fleet a la vista del selector del onboarding (mapeo explícito). */
export function buildDriverVehicleModel(m: FleetVehicleModelReply): DriverVehicleModelView {
  return {
    id: m.id,
    make: m.make,
    model: m.model,
    yearFrom: m.yearFrom,
    yearTo: m.yearTo,
    vehicleType: m.vehicleType,
    seats: m.seats,
  };
}

/** Mapea la página del catálogo (GET /drivers/vehicle-models) a la lista del selector. */
export function buildDriverVehicleModels(
  page: FleetVehicleModelPageReply,
): DriverVehicleModelView[] {
  return (page.items ?? []).map(buildDriverVehicleModel);
}

/**
 * Respuesta REST de fleet POST /vehicle-models (solicitud creada): el spec completo en revisión. Para el
 * conductor solo importa confirmar que quedó pendiente, así que se proyecta a lo mínimo.
 */
export interface FleetVehicleModelRequestReply {
  id: string;
  make: string;
  model: string;
  status: string;
}

/** Mapea la solicitud creada en fleet a la confirmación que ve el conductor. */
export function buildDriverModelRequest(m: FleetVehicleModelRequestReply): DriverModelRequestView {
  return { id: m.id, make: m.make, model: m.model, status: m.status };
}

export function buildDriverProfile(
  driver: DriverReply,
  user: UserReply,
  aggregate: AggregateReply,
  docs: DriverDocumentsReply,
): DriverProfileView {
  const documents: DriverDocumentView[] = (docs.documents ?? []).map((d) => ({
    type: d.type,
    status: d.status,
    expiresAt: emptyToNull(d.expiresAt),
    ok: isDocApproved(d.status),
  }));

  /** Documento del conductor para un tipo requerido (o undefined si nunca lo subió). */
  const docFor = (type: FleetDocumentType): DriverDocumentView | undefined =>
    documents.find((d) => d.type === type);

  // BACKWARD-COMPAT (sub-lote 3B · DNI requerido para el alta NUEVA): el DNI se exige solo a conductores
  // que SIGUEN en onboarding. Un conductor "ya pasó el onboarding" (legacy, DNI NO retroactivo) si CUALQUIERA:
  //  (a) ya tenía aprobados los 3 docs LEGACY (era compliant bajo las reglas viejas), o
  //  (b) está en un estado OPERATIVO/aprobado (currentStatus ∈ OPERATIONAL_DRIVER_STATUSES; OFFLINE NO
  //      cuenta porque es también el default de un conductor recién creado en pleno onboarding).
  // Así los conductores ya aprobados/operativos conservan la semántica de 3 docs (compliant intacto), y
  // solo el alta NUEVA (OFFLINE, sin docs aprobados aún) debe sumar el DNI para llegar a submittedAllRequired.
  const legacyAllApproved = REQUIRED_DRIVER_DOCS.every((type) => docFor(type)?.ok === true);
  const alreadyOnboarded =
    legacyAllApproved || OPERATIONAL_DRIVER_STATUSES.has(driver.currentStatus as DriverStatus);
  const effectiveRequired = alreadyOnboarded
    ? REQUIRED_DRIVER_DOCS
    : REQUIRED_DRIVER_DOCS_WITH_IDENTITY;

  // PRESENCIA: faltan los tipos para los que NO hay NINGÚN documento subido (a cualquier estado).
  // Un PENDING_REVIEW YA está subido → no es "faltante".
  const missing = effectiveRequired.filter((type) => {
    const doc = docFor(type);
    return doc === undefined || !isDocSubmitted(doc.status);
  });

  // RECHAZO: tipos requeridos cuyo documento fue rechazado (el conductor debe corregir-y-reenviar).
  const rejected = effectiveRequired.filter(
    (type) => docFor(type)?.status === FleetDocumentStatus.REJECTED,
  );

  // ENVIADO TODO: cada tipo requerido (efectivo) tiene un documento (a cualquier estado).
  const submittedAllRequired = missing.length === 0;

  // APROBADO TODO: cada tipo requerido (efectivo) tiene un documento VALID/EXPIRING_SOON. Para un
  // conductor ya-onboarded `effectiveRequired` es el set legacy, así que reusamos `legacyAllApproved`.
  const allApproved = alreadyOnboarded
    ? legacyAllApproved
    : effectiveRequired.every((type) => docFor(type)?.ok === true);

  // BIOMETRÍA ENROLADA (diferenciador no negociable VEO): el conductor enroló su rostro de referencia.
  // Eje SEPARADO de los documentos a propósito (decisión de diseño): `submittedAllRequired` es de DOCS;
  // la biometría es su propio hecho. La condición de "listo para revisión" (in_review) es
  // (submittedAllRequired AND biometricEnrolled), y el cliente la compone con AMBOS flags explícitos.
  // FUENTE: `faceEnrolledAt` del DriverReply gRPC (proto3 entrega "" si aún no enroló) — server-truth,
  // espeja `Driver.faceEnrolledAt`/`faceEmbedding` que identity exige en el gate de aprobación.
  const biometricEnrolled = driver.faceEnrolledAt.length > 0;

  return {
    driverId: driver.id,
    userId: driver.userId,
    phone: user.found ? user.phone : '',
    kycStatus: user.found ? user.kycStatus : '',
    currentStatus: driver.currentStatus,
    backgroundCheckStatus: driver.backgroundCheckStatus,
    // Wire gRPC entrega "" si no hay rechazo (proto3 defaults); lo normalizamos a null para la app.
    rejectionReason: emptyToNull(driver.rejectionReason),
    averageRating: driver.averageRating,
    rating: aggregate.found
      ? {
          rollingAvg30d: aggregate.rollingAvg30d,
          count30d: aggregate.count30d,
          flagged: aggregate.flagged,
          flagReason: emptyToNull(aggregate.flagReason),
        }
      : null,
    documents,
    compliance: {
      // `compliant` = TODOS los requeridos aprobados (semántica que ya consumía ProfileScreen). Antes
      // era `missing.length === 0` con `missing`=no-aprobados, que coincidía; ahora que `missing` es
      // PRESENCIA, el gate de aprobado se expresa explícito como `allApproved`.
      compliant: allApproved,
      // El set EFECTIVO de requeridos: legacy (3) para conductores ya-onboarded; legacy+DNI (4) para el
      // alta NUEVA. Así el cliente del onboarding ve el DNI como pendiente y el conductor ya aprobado no.
      requiredTypes: effectiveRequired,
      // PRESENCIA: tipos sin ningún documento subido (genuinamente faltantes), NO los no-aprobados.
      missing,
      // Tipos requeridos cuyo documento fue rechazado por el operador.
      rejected,
      // true si el conductor ya subió TODOS los requeridos (a revisión o aprobados).
      submittedAllRequired,
      // true si TODOS los requeridos están aprobados (VALID/EXPIRING_SOON).
      allApproved,
      // true si el conductor enroló su biometría facial (faceEnrolledAt presente). Eje SEPARADO de los
      // documentos: la condición de in_review es (submittedAllRequired AND biometricEnrolled).
      biometricEnrolled,
    },
  };
}
