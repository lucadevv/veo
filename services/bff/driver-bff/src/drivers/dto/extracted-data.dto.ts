/**
 * Validación FUERTE de `extractedData` (Lote 0 · data OCR on-device) como UNIÓN DISCRIMINADA por `type`
 * (= `FleetDocumentType`, sin string mágico). Reemplaza el `@IsObject()` liviano que dejaba pasar JSON
 * arbitrario al JSONB: cada variante declara SUS campos ACOTADOS, todos opcionales (el OCR degrada campo
 * a campo). Con `whitelist + forbidNonWhitelisted` del ValidationPipe, `@ValidateNested + @Type` recursa
 * y RECHAZA claves arbitrarias / fuera de rango, acotando tamaño y profundidad del payload.
 *
 * Este es el BORDE PÚBLICO (driver-bff): aquí la validación FUERTE es obligatoria — la app del conductor
 * manda el payload y este DTO es la primera barrera antes de proxyar a fleet.
 *
 * NOTA de duplicación: estas 4 clases viven IDÉNTICAS en driver-bff (borde público) y en fleet-service
 * (defensa en profundidad). No se extraen a un `@veo/*` porque (a) `@veo/shared-types` es CONTRATO DE
 * TIPOS PUROS sin class-validator (y su barrel lo consumen las apps RN — meterle decoradores arriesga el
 * bundle de Metro), y (b) ambos servicios usan `moduleResolution: Node` (node10), que NO honra el campo
 * `exports` → un subpath compartido no resolvería sin rutas `dist/` frágiles. El contrato de TIPOS
 * (`ExtractedDocumentData`) SÍ es único en shared-types; solo los DECORADORES se espejan. 4 clases chicas.
 */
import type { TypeOptions } from 'class-transformer';
import {
  Equals,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { FleetDocumentType } from '@veo/shared-types';

/** Tope de longitud de los strings de OCR (acota tamaño del JSONB; un nombre/placa/póliza no excede esto). */
const OCR_TEXT_MAX = 120;
/** Tope de un número de documento/licencia/póliza/placa (suficiente para PE; acota abuso). */
const OCR_ID_MAX = 40;
/** Fecha calendario ISO `YYYY-MM-DD` (sin hora): lo que el OCR extrae de un documento. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Año de fabricación razonable (sanity check del OCR de la tarjeta). */
const MIN_VEHICLE_YEAR = 1900;
const MAX_VEHICLE_YEAR = 2100;

/** DNI: data extraída del documento de identidad del conductor. */
export class ExtractedDniDataDto {
  /** Discriminante: SIEMPRE `FleetDocumentType.DNI` (sin string mágico). `@Equals` lo whitelista (con
   *  `forbidNonWhitelisted`) Y valida que coincida. */
  @Equals(FleetDocumentType.DNI)
  type!: typeof FleetDocumentType.DNI;

  @IsOptional()
  @IsString()
  @Length(1, OCR_TEXT_MAX)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Length(1, OCR_ID_MAX)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'birthdate debe tener formato YYYY-MM-DD' })
  birthdate?: string;
}

/** SOAT: data extraída de la póliza. */
export class ExtractedSoatDataDto {
  @Equals(FleetDocumentType.SOAT)
  type!: typeof FleetDocumentType.SOAT;

  @IsOptional()
  @IsString()
  @Length(1, OCR_ID_MAX)
  policyNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'expiresAt debe tener formato YYYY-MM-DD' })
  expiresAt?: string;
}

/** PROPERTY_CARD (tarjeta de propiedad): data extraída de la tarjeta del vehículo. */
export class ExtractedPropertyCardDataDto {
  @Equals(FleetDocumentType.PROPERTY_CARD)
  type!: typeof FleetDocumentType.PROPERTY_CARD;

  @IsOptional()
  @IsString()
  @Length(1, OCR_ID_MAX)
  plate?: string;

  @IsOptional()
  @IsString()
  @Length(1, OCR_TEXT_MAX)
  make?: string;

  @IsOptional()
  @IsString()
  @Length(1, OCR_TEXT_MAX)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_VEHICLE_YEAR)
  @Max(MAX_VEHICLE_YEAR)
  year?: number;

  @IsOptional()
  @IsString()
  @Length(1, OCR_ID_MAX)
  mtcCategory?: string;
}

/** LICENSE_A1: data extraída de la licencia de conducir. */
export class ExtractedLicenseA1DataDto {
  @Equals(FleetDocumentType.LICENSE_A1)
  type!: typeof FleetDocumentType.LICENSE_A1;

  @IsOptional()
  @IsString()
  @Length(1, OCR_ID_MAX)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'expiresAt debe tener formato YYYY-MM-DD' })
  expiresAt?: string;
}

/**
 * Opciones del `@Type` para el campo `extractedData` de un DTO contenedor: discriminador por `type`
 * (= FleetDocumentType, sin string mágico) que enruta a la sub-clase correcta. Con `@ValidateNested` +
 * `forbidNonWhitelisted` del ValidationPipe, la validación RECURSE en la clase elegida y rechaza claves
 * arbitrarias / campos fuera de rango. `keepDiscriminatorProperty` conserva `type` en el objeto resultante.
 */
export const EXTRACTED_DATA_TYPE_OPTIONS: TypeOptions = {
  discriminator: {
    property: 'type',
    subTypes: [
      { value: ExtractedDniDataDto, name: FleetDocumentType.DNI },
      { value: ExtractedSoatDataDto, name: FleetDocumentType.SOAT },
      { value: ExtractedPropertyCardDataDto, name: FleetDocumentType.PROPERTY_CARD },
      { value: ExtractedLicenseA1DataDto, name: FleetDocumentType.LICENSE_A1 },
    ],
  },
  keepDiscriminatorProperty: true,
};
