import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { VehicleType } from '@veo/shared-types';

/** Año mínimo razonable para el alta de vehículo (sanity check; BR-D04 >=2017 lo revalida fleet). */
const MIN_REASONABLE_VEHICLE_YEAR = 2005;
const CURRENT_YEAR = new Date().getUTCFullYear();

/** Placa peruana XXX-XXX (guion opcional). fleet normaliza y revalida con plateSchema. */
const PLATE_PATTERN = /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/i;

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

/** POST /drivers/biometric/enroll → body. Foto de referencia en base64 (BR-I02). */
export class EnrollFaceDto {
  @ApiProperty({ description: 'Foto de referencia del rostro en base64' })
  @IsString()
  photo!: string;
}

/** POST /drivers/shift/biometric/verify → body. Reto + frames del liveness (BR-I02). */
export class VerifyBiometricDto {
  @ApiProperty({ description: 'Id del reto de liveness emitido en /challenge' })
  @IsString()
  challengeId!: string;

  @ApiProperty({ description: 'Frames del reto en base64 (orden temporal)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  frames!: string[];
}

/** POST /drivers/me/documents → body. Registra/actualiza un documento del conductor (BR-I04). */
export class AddDocumentDto {
  @ApiProperty({ description: 'Tipo de documento (LICENSE_A1 | SOAT | PROPERTY_CARD | ITV | BACKGROUND_CHECK)' })
  @IsString()
  type!: string;

  @ApiProperty({ description: 'Número del documento' })
  @IsString()
  documentNumber!: string;

  @ApiPropertyOptional({ description: 'Fecha de emisión (ISO-8601)' })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({ description: 'Fecha de vencimiento (ISO-8601)' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Clave S3 del archivo, si la app ya lo subió por otra vía' })
  @IsOptional()
  @IsString()
  fileS3Key?: string;
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
 * POST /drivers/vehicles → body. Alta self-service del vehículo del conductor (onboarding). Se proxya
 * a fleet POST /api/v1/drivers/vehicles; el driverId lo resuelve fleet desde la identidad propagada.
 */
export class RegisterVehicleDto {
  @ApiProperty({ enum: VehicleType, description: 'Tipo de vehículo. CAR = automóvil; MOTO = moto-taxi.' })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: 'ABC-123', description: 'Placa peruana (XXX-XXX, guion opcional)' })
  @IsString()
  @Matches(PLATE_PATTERN, { message: 'Placa inválida (formato XXX-XXX)' })
  plate!: string;

  @ApiPropertyOptional({
    description:
      'Id del modelo del catálogo (VehicleModelSpec APPROVED) elegido en el onboarding. Si viene, ' +
      'fleet snapshotea make/model/vehicleType del spec e ignora el texto libre.',
  })
  @IsOptional()
  @IsUUID()
  modelSpecId?: string;

  @ApiPropertyOptional({ example: 'Honda', description: 'Marca (texto libre). Requerida solo sin modelSpecId.' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional({ example: 'CG 150', description: 'Modelo (texto libre). Requerido solo sin modelSpecId.' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiProperty({ example: 2021, description: `Año del vehículo (>= ${MIN_REASONABLE_VEHICLE_YEAR}). BR-D04 (>=2017) lo aplica fleet.` })
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
  phone: string;
  kycStatus: string;
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
  compliance: {
    compliant: boolean;
    requiredTypes: string[];
    missing: string[];
  };
}
