/**
 * Entidades del dominio de registro (alta de socio conductor). Sin dependencias de UI ni de la
 * capa de datos: describen el borrador del registro, el estado de cada documento y el estado
 * global de la solicitud que conmuta la navegación.
 */
import { FleetDocumentType, VehicleClass } from '@veo/shared-types';
import type {
  AddDocumentRequest,
  DriverBiometricEnrollRequest,
  DriverBiometricEnrollResult,
  DriverDocument,
  DriverDocumentSimpleStatus,
  DriverOnboardRequest,
  DriverModelRequestView,
  DriverPersonalData,
  DriverPersonalDataRequest,
  DriverResubmitResult,
  DriverVehicleModelView,
  DriverVehicleView,
  RegisterVehicleRequest,
  RequestVehicleModelRequest,
} from '@veo/api-client';

/**
 * Re-exporta los contratos del cliente de API que consumen las capas data/presentation del alta,
 * para que dependan del dominio y no del paquete directamente.
 *  - `RegistrationDocumentRequest` (= addDocumentRequest): body de `POST /drivers/me/documents`.
 *  - `RegistrationDocumentView` (= driverDocument): documento real con `simpleStatus` para los chips.
 *  - `LicenseOnboardInput` (= driverOnboardRequest): alta de licencia.
 *  - `BiometricEnrollInput`/`Result`: enrolamiento del rostro de referencia (base64).
 *  - `PersonalDataInput`/`PersonalDataView` (= driverPersonalData[Request]): `PATCH /drivers/me/personal`.
 *  - `VehicleRegisterInput`/`VehicleView` (= registerVehicleRequest / driverVehicleView): `/drivers/vehicles`.
 */
export type RegistrationDocumentRequest = AddDocumentRequest;
export type RegistrationDocumentView = DriverDocument;
export type RegistrationDocumentServerStatus = DriverDocumentSimpleStatus;
export type LicenseOnboardInput = DriverOnboardRequest;
export type BiometricEnrollInput = DriverBiometricEnrollRequest;
export type BiometricEnrollResult = DriverBiometricEnrollResult;
export type PersonalDataInput = DriverPersonalDataRequest;
export type PersonalDataView = DriverPersonalData;
export type VehicleRegisterInput = RegisterVehicleRequest;
export type VehicleView = DriverVehicleView;
/** Modelo del catálogo curado que el conductor elige en el alta (= driverVehicleModelView · B5-2). */
export type VehicleModelOption = DriverVehicleModelView;
/** Body para solicitar un modelo nuevo que no está en el catálogo (= requestVehicleModelRequest · B5-2.c). */
export type VehicleModelRequestInput = RequestVehicleModelRequest;
/** Confirmación de que la solicitud de modelo quedó en revisión (= driverModelRequestView · B5-2.c). */
export type VehicleModelRequestResult = DriverModelRequestView;
/** Resultado de `POST /drivers/me/resubmit` (reenvío a revisión tras rechazo): estado de antecedentes. */
export type ResubmitResult = DriverResubmitResult;

/**
 * Tipo de vehículo declarado por el conductor en el alta. Re-export del enum CANÓNICO
 * `VehicleClass` de `@veo/shared-types` (ADR 013 §1.6: la definición local muere; el wire field
 * sigue siendo `vehicleType`). Exporta valor + tipo: el store del wizard usa `VehicleType.MOTO`
 * como default sin strings mágicos.
 */
export const VehicleType = VehicleClass;
export type VehicleType = VehicleClass;

/** Paso 1: datos personales tal como aparecen en el DNI. */
export interface PersonalData {
  fullName: string;
  /** DNI peruano (8 dígitos; el formateo con espacios es solo de presentación). */
  dni: string;
  /** Fecha de nacimiento en formato DD/MM/AAAA (validación fina la hará el backend). */
  birthdate: string;
}

/**
 * Paso 2: datos del vehículo. B5-2: el conductor ELIGE marca/modelo del catálogo curado (no texto
 * libre). `modelSpecId` es el id del modelo elegido (lo que viaja al backend); `brand`/`model` son la
 * etiqueta de presentación de ese modelo (para mostrar la elección y rehidratar). Vacíos hasta elegir.
 */
export interface VehicleData {
  type: VehicleType;
  plate: string;
  year: string;
  /** Id del VehicleModelSpec elegido del catálogo (lo que se envía en `POST /drivers/vehicles`). */
  modelSpecId: string;
  /** Marca del modelo elegido — solo presentación (el backend la snapshotea del spec). */
  brand: string;
  /** Modelo elegido — solo presentación. */
  model: string;
}

/**
 * Documentos requeridos en el alta (paso 3). Es una etiqueta INTERNA, app-friendly, del wizard
 * (`VEHICLE_REGISTRATION` = "tarjeta de propiedad" en la UI); el valor que viaja al backend NO es
 * este label sino el `FleetDocumentType` canónico que devuelve `registrationDocTypeToBackend`.
 */
export type RegistrationDocumentType = 'LICENSE' | 'SOAT' | 'VEHICLE_REGISTRATION';

/**
 * Subconjunto CANÓNICO de `FleetDocumentType` que el alta exige en el paso 3 (los tres documentos del
 * wizard: licencia A1, SOAT y tarjeta de propiedad). Es el rango EXACTO de `registrationDocTypeToBackend`
 * — tiparlo así (en vez del enum completo) deja que la presentación derive su config contextual del
 * formulario sin castear, y que un tipo nuevo del alta sea un error de compilación.
 */
export type RegistrationFleetDocumentType =
  | typeof FleetDocumentType.LICENSE_A1
  | typeof FleetDocumentType.SOAT
  | typeof FleetDocumentType.PROPERTY_CARD;

/**
 * Mapea la etiqueta del wizard al `FleetDocumentType` CANÓNICO de `@veo/shared-types` que validan
 * el `addDocumentRequest.type` / `documentUploadTicketRequest.type` (el presign del driver-bff hace
 * `@IsEnum(FleetDocumentType)`). El retorno está tipado al subconjunto del alta y el `switch` es
 * exhaustivo (sin `default`), así que cualquier futura deriva del label es un ERROR DE COMPILACIÓN, no
 * un 400 en runtime. La "tarjeta de propiedad" es `PROPERTY_CARD` (NO el string mágico
 * `VEHICLE_REGISTRATION`, que no existe en el enum). La licencia se registra como `LICENSE_A1`.
 */
export function registrationDocTypeToBackend(
  type: RegistrationDocumentType,
): RegistrationFleetDocumentType {
  switch (type) {
    case 'LICENSE':
      return FleetDocumentType.LICENSE_A1;
    case 'SOAT':
      return FleetDocumentType.SOAT;
    case 'VEHICLE_REGISTRATION':
      return FleetDocumentType.PROPERTY_CARD;
  }
}

/** Estado de carga de un documento del alta. */
export type DocumentUploadStatus = 'pending' | 'uploaded';

export interface RegistrationDocument {
  type: RegistrationDocumentType;
  status: DocumentUploadStatus;
}

/**
 * Captura facial del alta (KYC). Referencia OPACA emitida por el proveedor de captura/backend; la
 * app nunca manipula la imagen cruda (regla de privacidad: el rostro solo verifica identidad).
 */
export interface FaceCapture {
  /** Referencia opaca de la sesión de captura (liveness + match). */
  ref: string;
  /** Score informativo [0..1] para la UI. */
  score: number;
  /** Marca de tiempo ISO de la captura. */
  capturedAt: string;
  /**
   * Foto de referencia en base64 (sin prefijo data:) para `POST /drivers/biometric/enroll`. Solo la
   * emite un proveedor de captura REAL; el stub la deja `undefined` (no hay imagen cruda en demo).
   */
  photoBase64?: string;
}

/**
 * Estado global del registro del conductor. Conmuta la navegación raíz:
 *  - `not_started` / `in_progress` → wizard de 4 pasos
 *  - `in_review` → pantalla "Estamos revisando tus datos"
 *  - `approved` → app operativa (tabs)
 *  - `rejected` → wizard para corregir (reservado; el backend definirá el detalle)
 */
export type RegistrationStatus =
  | 'not_started'
  | 'in_progress'
  | 'in_review'
  | 'approved'
  | 'rejected';

/** Borrador completo del registro que se envía al backend al finalizar el wizard. */
export interface RegistrationDraft {
  personal: PersonalData;
  vehicle: VehicleData;
  documents: RegistrationDocument[];
  /** Referencia de la captura facial (null mientras no se complete el paso 4). */
  faceCaptureRef: string | null;
}

/** Resultado del envío del alta (lo que el backend responde sobre el estado de la solicitud). */
export interface RegistrationSubmissionResult {
  status: RegistrationStatus;
}
