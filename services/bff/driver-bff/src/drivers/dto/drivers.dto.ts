import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DocumentSide,
  FleetDocumentType,
  OCR_ENGINES,
  OcrEngine,
  PLATE_PATTERN,
  PLATE_INVALID_MESSAGE,
  VehicleType,
  type ExtractedDocumentData,
} from '@veo/shared-types';
import { EXTRACTED_DATA_TYPE_OPTIONS } from './extracted-data.dto';

/** Año mínimo razonable para el alta de vehículo (sanity check; BR-D04 >=2017 lo revalida fleet). */
const MIN_REASONABLE_VEHICLE_YEAR = 2005;
const CURRENT_YEAR = new Date().getUTCFullYear();

/** Fecha de nacimiento en formato calendario yyyy-mm-dd (sin hora). */
const BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** DNI peruano: exactamente 8 dígitos. */
const DNI_PATTERN = /^\d{8}$/;

export class OnboardDto {
  @ApiProperty({ description: 'Número de licencia de conducir (A1)' })
  @IsString()
  licenseNumber!: string;

  @ApiProperty({ description: 'Fecha de vencimiento de la licencia (ISO-8601)' })
  @IsISO8601()
  licenseExpiresAt!: string;
}

export class StartShiftDto {
  @ApiProperty({ description: 'Referencia de la sesión biométrica de inicio de turno (BR-I02)' })
  @IsString()
  sessionRef!: string;

  @ApiPropertyOptional({ description: 'Latitud de inicio de turno' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  geoLat?: number;

  @ApiPropertyOptional({ description: 'Longitud de inicio de turno' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  geoLon?: number;
}

/**
 * POST /drivers/biometric/enroll → body. Enrolamiento KYC con UNA selfie, SIN prueba de vida (Lote 1): el
 * conductor manda una sola foto en base64 (`photo`, sin prefijo data:). El BFF solo valida shape y proxya a
 * identity-service, que deriva el embedding de referencia vía biometric-service `/v1/embed`. Reemplaza el
 * contrato de liveness `{ challengeId, frames }` (el alta ya no corre el reto girar/asentir).
 */
export class EnrollFaceDto {
  @ApiProperty({ description: 'Selfie de referencia en base64 (sin prefijo data:)' })
  @IsString()
  @IsNotEmpty()
  photo!: string;
}

/** M4 — topes del payload del verify en el BORDE del BFF (defense-in-depth; identity re-valida estricto). */
const MAX_VERIFY_FRAMES = 10;
const FRAME_BASE64_MIN = 2_000;
const FRAME_BASE64_MAX = 1_500_000;

/** POST /drivers/shift/biometric/verify → body. Reto + frames del liveness (BR-I02). */
export class VerifyBiometricDto {
  @ApiProperty({ description: 'Id del reto de liveness emitido en /challenge' })
  @IsString()
  challengeId!: string;

  // M4 — acota cantidad (@ArrayMaxSize) y tamaño por-frame (@Length) ANTES de reenviar a identity: un cliente
  // no puede empujar un array de miles de strings gigantes por el borde del BFF. identity re-valida base64+tamaño.
  @ApiProperty({ description: 'Frames del reto en base64 (orden temporal)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_VERIFY_FRAMES)
  @IsString({ each: true })
  @Length(FRAME_BASE64_MIN, FRAME_BASE64_MAX, { each: true })
  frames!: string[];
}

/** Tope de imágenes por documento/presign (DNI=2; foto de vehículo N). Espeja MAX_DOCUMENT_IMAGES de fleet. */
export const MAX_DOCUMENT_UPLOAD_SIDES = 10;

/**
 * Una imagen del documento (sub-lote 3A): la clave S3 ya subida (vía presign) + la cara. Tipado fuerte
 * en `side` (DocumentSide) — sin string suelto. El driver-bff la reenvía a fleet en `images[]`.
 */
export class AddDocumentImageDto {
  @ApiProperty({ description: 'Clave S3 del binario ya subido (devuelta por el presign)' })
  @IsString()
  @IsNotEmpty()
  s3Key!: string;

  @ApiProperty({ enum: DocumentSide, description: 'Cara del documento: FRONT | BACK | SINGLE' })
  @IsEnum(DocumentSide)
  side!: DocumentSide;
}

/** POST /drivers/me/documents → body. Registra/actualiza un documento del conductor (BR-I04). */
export class AddDocumentDto {
  @ApiProperty({
    description: 'Tipo de documento (LICENSE_A1 | SOAT | PROPERTY_CARD | ITV | BACKGROUND_CHECK)',
  })
  @IsString()
  type!: string;

  // Número requerido POR TIPO: la foto del vehículo (VEHICLE_PHOTO) es una foto sin número; el resto
  // (licencia/SOAT/tarjeta/…) lo exige. @ValidateIf saltea la validación solo para la foto.
  @ApiPropertyOptional({ description: 'Número del documento (requerido salvo VEHICLE_PHOTO)' })
  @ValidateIf((o: AddDocumentDto) => o.type !== FleetDocumentType.VEHICLE_PHOTO)
  @IsString()
  @IsNotEmpty()
  documentNumber?: string;

  @ApiPropertyOptional({ description: 'Fecha de emisión (ISO-8601)' })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({ description: 'Fecha de vencimiento (ISO-8601)' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'DEPRECADO: usar `images`. Clave S3 singular del archivo' })
  @IsOptional()
  @IsString()
  fileS3Key?: string;

  /**
   * Imágenes del documento (sub-lote 3A · camino nuevo, 1..N caras). DNI → [FRONT, BACK]; foto de
   * vehículo → N SINGLE; el resto → [SINGLE]. Opcional para no romper a quien aún mande `fileS3Key`.
   */
  @ApiPropertyOptional({
    type: [AddDocumentImageDto],
    description: 'Imágenes del documento (1..N caras)',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_DOCUMENT_UPLOAD_SIDES)
  @ValidateNested({ each: true })
  @Type(() => AddDocumentImageDto)
  images?: AddDocumentImageDto[];

  /**
   * Onboarding sin-formularios (Lote 0): data extraída por OCR on-device (contrato `ExtractedDocumentData`
   * de @veo/shared-types, unión discriminada por `type`). BORDE PÚBLICO → validación FUERTE: `@ValidateNested`
   * + `@Type` con discriminador por `type` (= FleetDocumentType) enruta a la sub-clase y, con
   * `forbidNonWhitelisted`, acota campos/tamaño y rechaza claves arbitrarias ANTES de proxyar a fleet.
   * Opcional → backward-compatible (registrar SIN OCR sigue OK). Sin `any`.
   */
  @ApiPropertyOptional({
    description: 'Data extraída por OCR on-device (ExtractedDocumentData, opcional)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => Object, EXTRACTED_DATA_TYPE_OPTIONS)
  extractedData?: ExtractedDocumentData;

  /** Motor de OCR que produjo `extractedData`. ENUM CERRADO (anti-spoof de texto libre). Trazabilidad. */
  @ApiPropertyOptional({
    enum: OcrEngine,
    description: 'Motor de OCR que extrajo la data (enum cerrado)',
  })
  @IsOptional()
  @IsIn(OCR_ENGINES)
  ocrEngine?: OcrEngine;

  /** Momento en que el cliente extrajo la data por OCR (ISO-8601). */
  @ApiPropertyOptional({
    example: '2026-06-20T10:00:00.000Z',
    description: 'Instante de la extracción OCR',
  })
  @IsOptional()
  @IsISO8601()
  ocrAt?: string;
}

/**
 * Content-Types permitidos para subir el binario de un documento (foto JPEG/PNG o PDF). Allowlist
 * ÚNICA (Ley 29733: el binario es PII). DEBE coincidir con la de media-service: el `contentType`
 * viaja firmado en la URL prefirmada, así que un valor fuera de esta lista produce una subida inválida.
 */
export const DOCUMENT_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type DocumentUploadContentType = (typeof DOCUMENT_UPLOAD_CONTENT_TYPES)[number];

/**
 * Extensión de archivo por Content-Type (mapa TIPADO, sin comparaciones de string sueltas). La key
 * S3 termina con la extensión derivada del contentType, no de un nombre que mande el cliente.
 */
export const DOCUMENT_EXTENSION_BY_CONTENT_TYPE: Record<DocumentUploadContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/**
 * POST /drivers/me/documents/presign → body. La app pide N tickets de subida (uno POR CARA) para el
 * binario de un documento (sub-lote 3A · múltiples imágenes). `type` es un FleetDocumentType tipado;
 * `contentType` está en la allowlist; `sides` son las caras a subir (FRONT|BACK|SINGLE) — 1..N.
 *
 * Backward-compat: `sides` es OPCIONAL. Si la app NO lo manda, se asume `[SINGLE]` (una imagen, el
 * comportamiento histórico de 1 ticket). DNI → `[FRONT, BACK]`; foto de vehículo → N `[SINGLE, SINGLE, ...]`.
 */
export class DocumentUploadTicketDto {
  @ApiProperty({
    enum: FleetDocumentType,
    description:
      'Tipo de documento (LICENSE_A1 | SOAT | PROPERTY_CARD | ITV | BACKGROUND_CHECK | ...)',
  })
  @IsEnum(FleetDocumentType)
  type!: FleetDocumentType;

  @ApiProperty({
    enum: DOCUMENT_UPLOAD_CONTENT_TYPES,
    description: 'Content-Type del binario a subir (que el cliente reenviará exacto en el PUT)',
  })
  @IsIn(DOCUMENT_UPLOAD_CONTENT_TYPES)
  contentType!: DocumentUploadContentType;

  @ApiPropertyOptional({
    enum: DocumentSide,
    isArray: true,
    description: 'Caras a subir (1..N). Default [SINGLE] si se omite (backward-compat 1 imagen).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_DOCUMENT_UPLOAD_SIDES)
  @IsEnum(DocumentSide, { each: true })
  sides?: DocumentSide[];
}

/** Un ticket de subida por CARA: la cara, la URL PUT prefirmada, la key S3 y los headers obligatorios. */
export interface DocumentUploadSideTicket {
  side: DocumentSide;
  uploadUrl: string;
  fileS3Key: string;
  requiredHeaders: Record<string, string>;
}

/**
 * Ticket(s) de subida que el driver-bff devuelve a la app (sub-lote 3A · N imágenes):
 *  - `tickets`: uno por cara (side + uploadUrl + fileS3Key + requiredHeaders).
 *  - `expiresAt`: vencimiento común de los tickets (ISO-8601).
 * La app sube cada binario con un PUT a su `uploadUrl`, luego llama POST /drivers/me/documents con las
 * `images: [{ s3Key, side }]` (una por cara). Compat: para 1 imagen, `tickets` trae un solo elemento SINGLE.
 */
export interface DocumentUploadTicketView {
  tickets: DocumentUploadSideTicket[];
  expiresAt: string;
}

/** Vista del estado de un documento del conductor para el panel de cumplimiento. */
export interface DriverDocumentView {
  type: string;
  status: string;
  expiresAt: string | null;
  /** true si el documento está vigente (VALID o EXPIRING_SOON). */
  ok: boolean;
}

/** Estado simple del documento para la app del conductor. */
export type DriverDocumentSimpleStatus =
  | 'vigente'
  | 'por_vencer'
  | 'vencido'
  | 'en_revision'
  | 'rechazado';

/** Cara de una imagen del documento proyectada al conductor (sub-lote 3A · SIN la key S3 interna). */
export interface DriverDocumentImageView {
  side: DocumentSide;
  order: number;
  /**
   * Presigned GET de vida corta (120s) para RE-RENDERIZAR esta cara desde el servidor en el resume del
   * onboarding (sin cachear PII en local). null si la firma falló (FAIL-SOFT) — la lista de docs igual
   * responde y la app degrada (no muestra el preview de esa cara). La key S3 NUNCA se proyecta al cliente.
   */
  url: string | null;
}

/** Vista detallada de un documento del conductor (GET /drivers/me/documents). */
export interface DriverDocumentDetail {
  type: string;
  documentNumber: string;
  /** Estado crudo de fleet (VALID/EXPIRING_SOON/EXPIRED/PENDING_REVIEW/REJECTED). */
  status: string;
  /** Estado simple en español para la UI. */
  simpleStatus: DriverDocumentSimpleStatus;
  expiresAt: string | null;
  /** true si el documento está vigente (VALID o EXPIRING_SOON). */
  ok: boolean;
  /** M5: motivo del rechazo (operador); null si no rechazado o sin motivo. El conductor lo VE. */
  rejectionReason: string | null;
  /**
   * Sub-lote 3A: las caras del documento (side + order), SIN la key S3 (interna). La app las usa para
   * saber qué caras ya subió (p.ej. DNI: FRONT y/o BACK). El binario solo lo firma el admin-bff.
   */
  images: DriverDocumentImageView[];
}

/**
 * PATCH /drivers/me/personal → body. Datos personales del conductor (PII). Se proxya por REST
 * interno firmado a identity-service (la PII NO viaja por gRPC). identity persiste y devuelve el
 * mismo shape.
 */
export class UpdateDriverPersonalDto {
  @ApiProperty({ description: 'Nombre legal completo del conductor', minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  legalName!: string;

  @ApiProperty({ description: 'DNI peruano (8 dígitos)', example: '12345678' })
  @IsString()
  @Matches(DNI_PATTERN, { message: 'El DNI debe tener exactamente 8 dígitos' })
  dni!: string;

  @ApiProperty({ description: 'Fecha de nacimiento (yyyy-mm-dd)', example: '1990-05-21' })
  @IsString()
  @Matches(BIRTH_DATE_PATTERN, { message: 'birthDate debe tener formato yyyy-mm-dd' })
  @IsISO8601({ strict: true }, { message: 'birthDate debe ser una fecha válida (yyyy-mm-dd)' })
  birthDate!: string;
}

/**
 * VISTA de datos personales del conductor que devuelve identity-service (PATCH /drivers/me/personal).
 * Nullable: las columnas en identity son nullables y la vista las lee tal cual (puede devolver null si
 * el conductor aún no completó el dato). Alineado con identity-view ↔ api-client (driverPersonalData).
 */
export interface DriverPersonalData {
  legalName: string | null;
  dni: string | null;
  birthDate: string | null;
}

/**
 * POST /drivers/me/check-dni → body. Chequea si el DNI escaneado ya está registrado en OTRA cuenta de
 * conductor (blind index `dni_hash`) ANTES de completar el alta. Se proxya por REST interno firmado a
 * identity-service (PII no viaja por gRPC), mismo patrón que `UpdateDriverPersonalDto`.
 */
export class CheckDniDto {
  @ApiProperty({ description: 'DNI peruano (8 dígitos)', example: '12345678' })
  @IsString()
  @Matches(DNI_PATTERN, { message: 'El DNI debe tener exactamente 8 dígitos' })
  dni!: string;
}

/** POST /drivers/me/check-dni → respuesta: `exists` = true si el DNI YA pertenece a OTRA cuenta. */
export interface DriverDniCheckResult {
  exists: boolean;
}

/**
 * POST /drivers/vehicles → body. Alta self-service del vehículo del conductor (onboarding). Se proxya
 * a fleet POST /api/v1/drivers/vehicles; el driverId lo resuelve fleet desde la identidad propagada.
 */
export class RegisterVehicleDto {
  @ApiProperty({
    enum: VehicleType,
    description: 'Tipo de vehículo. CAR = automóvil; MOTO = moto-taxi.',
  })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({
    example: 'ABC-123',
    description: 'Placa peruana (auto ABC-123 o moto 1234-AB, guion opcional)',
  })
  @IsString()
  @Matches(PLATE_PATTERN, { message: PLATE_INVALID_MESSAGE })
  plate!: string;

  @ApiPropertyOptional({
    description:
      'Id del modelo del catálogo (VehicleModelSpec APPROVED) elegido en el onboarding. Si viene, ' +
      'fleet snapshotea make/model/vehicleType del spec e ignora el texto libre.',
  })
  @IsOptional()
  @IsUUID()
  modelSpecId?: string;

  @ApiPropertyOptional({
    example: 'Honda',
    description: 'Marca (texto libre). Requerida solo sin modelSpecId.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional({
    example: 'CG 150',
    description: 'Modelo (texto libre). Requerido solo sin modelSpecId.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiProperty({
    example: 2021,
    description: `Año del vehículo (>= ${MIN_REASONABLE_VEHICLE_YEAR}). BR-D04 (>=2017) lo aplica fleet.`,
  })
  @IsInt()
  @Min(MIN_REASONABLE_VEHICLE_YEAR)
  @Max(CURRENT_YEAR + 1)
  year!: number;

  @ApiPropertyOptional({ example: 'Rojo' })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  color?: string;
}

/** Body para seleccionar el vehículo ACTIVO del conductor (PATCH /drivers/active-vehicle). */
export class SelectActiveVehicleDto {
  @ApiProperty({ description: 'Id del vehículo del conductor a marcar como activo' })
  @IsUUID()
  vehicleId!: string;
}

/**
 * Vista del vehículo del conductor para la app (POST /drivers/vehicles y GET /drivers/vehicles).
 * `status` = estado de revisión del onboarding (PENDING_REVIEW|ACTIVE); `docStatus` = estado
 * documental agregado del vehículo.
 */
export interface DriverVehicleView {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: string;
  status: string;
  docStatus: string;
}

/**
 * GET /drivers/vehicle-models → query del catálogo curado (B5-2). El conductor filtra por tipo (un
 * mototaxista solo ve motos) y busca por marca/modelo. Se proxya a fleet GET /vehicle-models.
 */
export class ListVehicleModelsQuery {
  @ApiPropertyOptional({ enum: VehicleType, description: 'Filtra por tipo (CAR|MOTO).' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'Búsqueda por marca o modelo (contains, case-insensitive).' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  q?: string;
}

/**
 * Modelo del catálogo para el selector del onboarding (GET /drivers/vehicle-models). Subconjunto del
 * spec de fleet: lo que la app necesita para mostrar y elegir (no expone campos de revisión).
 */
export interface DriverVehicleModelView {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  vehicleType: string;
  seats: number;
}

/**
 * POST /drivers/vehicle-models → body. El conductor SOLICITA un modelo que no está en el catálogo (B5-2.c).
 * Trae solo lo que conoce; fleet lo guarda PENDING_REVIEW y el operador completa la ficha técnica al aprobar.
 */
export class RequestVehicleModelDto {
  @ApiProperty({ example: 'Toyota' })
  @IsString()
  @Length(1, 60)
  make!: string;

  @ApiProperty({ example: 'Probox' })
  @IsString()
  @Length(1, 60)
  model!: string;

  @ApiProperty({ example: 2015 })
  @IsInt()
  @Min(MIN_REASONABLE_VEHICLE_YEAR)
  @Max(CURRENT_YEAR + 1)
  yearFrom!: number;

  @ApiProperty({ example: 2024 })
  @IsInt()
  @Min(MIN_REASONABLE_VEHICLE_YEAR)
  @Max(CURRENT_YEAR + 1)
  yearTo!: number;

  @ApiProperty({ enum: VehicleType, description: 'CAR | MOTO.' })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: 5, description: 'Asientos (1..20).' })
  @IsInt()
  @Min(1)
  @Max(20)
  seats!: number;
}

/** Confirmación al conductor de que su solicitud de modelo quedó en revisión (PENDING_REVIEW). */
export interface DriverModelRequestView {
  id: string;
  make: string;
  model: string;
  status: string;
}

/** Perfil agregado del conductor (gRPC identity + rating + fleet). */
export interface DriverProfileView {
  driverId: string;
  userId: string;
  /** Nombre legal del conductor (onboarding). `null` si aún no se capturó. Su propio dato (saludo). */
  fullName: string | null;
  phone: string;
  kycStatus: string;
  /** Foto de perfil (avatar) del conductor · publicUrl del media-service; `null` si no tiene (fallback a iniciales). */
  photoUrl: string | null;
  currentStatus: string;
  backgroundCheckStatus: string;
  /** Motivo del último rechazo de antecedentes; null si no está rechazado o no se dio motivo. */
  rejectionReason: string | null;
  averageRating: number;
  rating: {
    rollingAvg30d: number;
    count30d: number;
    flagged: boolean;
    flagReason: string | null;
  } | null;
  documents: DriverDocumentView[];
  /**
   * Cumplimiento documental del CONDUCTOR (solo los docs que sube en el alta: licencia, SOAT, tarjeta).
   * Distingue el ciclo de vida real de cada tipo requerido: no-enviado vs enviado/PENDING_REVIEW vs
   * aprobado. `backgroundCheckStatus`/`kycStatus` viven en sus propios ejes del perfil (no acá).
   */
  compliance: {
    /** true si TODOS los requeridos están APROBADOS (VALID/EXPIRING_SOON). Alias de `allApproved`. */
    compliant: boolean;
    /** Tipos requeridos (los que el conductor sube en el alta). */
    requiredTypes: string[];
    /** Tipos requeridos SIN ningún documento subido (presencia: genuinamente faltantes). */
    missing: string[];
    /** Tipos requeridos cuyo documento fue RECHAZADO por el operador (corregir-y-reenviar). */
    rejected: string[];
    /** true si el conductor ya subió TODOS los requeridos (a cualquier estado). */
    submittedAllRequired: boolean;
    /** true si TODOS los requeridos están aprobados (VALID/EXPIRING_SOON). */
    allApproved: boolean;
    /**
     * true si el conductor enroló su biometría facial de referencia (diferenciador no negociable VEO).
     * Eje SEPARADO de los documentos: la condición de "listo para revisión" (in_review) es
     * (submittedAllRequired AND biometricEnrolled). El gate FUERTE server-side vive en la APROBACIÓN
     * del operador (identity `approve`, 409 sin embedding); este flag es el reflejo para el cliente.
     */
    biometricEnrolled: boolean;
  };
}
