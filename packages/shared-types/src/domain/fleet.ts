import { type FleetDocumentType } from '../enums/index.js';
import type { FleetDocumentStatus } from '../enums/index.js';

/** Documento de conductor o vehículo con vencimiento (BR-I04, BR-D04). */
export interface FleetDocument {
  id: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  type: FleetDocumentType;
  documentNumber: string;
  issuedAt?: Date;
  expiresAt?: Date;
  fileS3Key?: string;
  status: FleetDocumentStatus;
  verifiedAt?: Date;
  verifiedBy?: string;
}

/**
 * Onboarding sin-formularios (Lote 0) · DATA EXTRAÍDA por OCR on-device de cada documento.
 *
 * Hoy el OCR corre en el cliente y la data se descartaba: nunca llegaba al backend. Este contrato la
 * persiste como `FleetDocument.extractedData` (columna Json nullable) para que el admin la vea y la
 * RE-VERIFIQUE antes de aprobar. NO es dato crítico de seguridad: es una conveniencia de pre-llenado,
 * la fuente de verdad legal sigue siendo la revisión manual del operador.
 *
 * UNIÓN DISCRIMINADA por `type` (FleetDocumentType, NUNCA string suelto): cada tipo de documento OCR-able
 * declara SUS campos, todos OPCIONALES (el OCR puede fallar campo a campo → degradación honesta). Solo los
 * tipos que el cliente sabe parsear aparecen acá; el resto de FleetDocumentType no produce data extraída.
 */
export interface ExtractedDniData {
  type: typeof FleetDocumentType.DNI;
  /** Nombre completo tal como figura en el DNI. */
  fullName?: string;
  /** Número de DNI. */
  documentNumber?: string;
  /** Fecha de nacimiento, ISO `YYYY-MM-DD`. */
  birthdate?: string;
}

export interface ExtractedSoatData {
  type: typeof FleetDocumentType.SOAT;
  /** Número de póliza SOAT. */
  policyNumber?: string;
  /** Vencimiento de la póliza, ISO `YYYY-MM-DD`. */
  expiresAt?: string;
}

export interface ExtractedPropertyCardData {
  type: typeof FleetDocumentType.PROPERTY_CARD;
  /** Placa del vehículo. */
  plate?: string;
  /** Marca (raw del OCR). */
  make?: string;
  /** Modelo (raw del OCR). */
  model?: string;
  /** Año de fabricación. */
  year?: number;
  /** Categoría MTC RAW tal cual la imprime la tarjeta (ej. "M1" / "N1" / "L3" / "M1SC"). NO se normaliza
   *  acá: el mapeo a la taxonomía de flota es del Lote 2 (parser de tarjeta). */
  mtcCategory?: string;
}

export interface ExtractedLicenseA1Data {
  type: typeof FleetDocumentType.LICENSE_A1;
  /** Número de la licencia. */
  documentNumber?: string;
  /** Vencimiento de la licencia, ISO `YYYY-MM-DD`. */
  expiresAt?: string;
  /** Categoría canónica leída por OCR (`A-I`/`B-IIb`/…). Clase + categoría del documento real, combinadas.
   *  Conveniencia para validar elegibilidad auto/moto en el backend a futuro; NO es dato crítico. */
  category?: string;
}

/**
 * Data extraída por OCR de un documento, discriminada por `type` (FleetDocumentType). Solo los tipos
 * OCR-ables del onboarding (DNI, SOAT, PROPERTY_CARD, LICENSE_A1) están cubiertos. El backend la acepta
 * y la persiste tal cual (Lote 0); el cliente la PRODUCE (Lote 1) y el parser de tarjeta la enriquece
 * (Lote 2). Todos los campos son opcionales → un OCR parcial sigue siendo válido.
 */
export type ExtractedDocumentData =
  | ExtractedDniData
  | ExtractedSoatData
  | ExtractedPropertyCardData
  | ExtractedLicenseA1Data;

/**
 * Motor de OCR que produjo la `ExtractedDocumentData` (trazabilidad/observabilidad). ENUM CERRADO
 * (no texto libre): el valor lo emite el cliente y se persiste tal cual, así que un set cerrado evita
 * que un `ocrEngine` spoofeable/arbitrario entre al JSONB de trazabilidad. Solo los 3 motores que VEO
 * corre hoy (on-device iOS/Android + el server PaddleOCR del Lote 2) son válidos; agregar uno nuevo es
 * un cambio explícito acá (y rompe el typecheck de quien no lo contemple — intencional).
 *  - `ios-visionkit`: VisionKit on-device (iOS).
 *  - `android-mlkit`: ML Kit on-device (Android).
 *  - `paddleocr-server`: PaddleOCR server-side (Lote 2, parser de tarjeta).
 */
export const OcrEngine = {
  IOS_VISIONKIT: 'ios-visionkit',
  ANDROID_MLKIT: 'android-mlkit',
  PADDLEOCR_SERVER: 'paddleocr-server',
} as const;
export type OcrEngine = (typeof OcrEngine)[keyof typeof OcrEngine];

/** Valores de `OcrEngine` para validadores de borde (`@IsIn(OCR_ENGINES)`). Derivado del const, no re-tipeado. */
export const OCR_ENGINES = Object.values(OcrEngine) as [OcrEngine, ...OcrEngine[]];

/** Inspección técnica trimestral del vehículo (BR-D04). */
export interface Inspection {
  id: string;
  vehicleId: string;
  inspectorId: string;
  inspectedAt: Date;
  passed: boolean;
  notes?: string;
  nextDueAt: Date;
}
