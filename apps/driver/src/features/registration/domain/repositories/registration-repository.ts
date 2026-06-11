import type {
  BiometricEnrollInput,
  BiometricEnrollResult,
  LicenseOnboardInput,
  PersonalDataInput,
  PersonalDataView,
  RegistrationDocumentRequest,
  RegistrationDocumentView,
  RegistrationDraft,
  RegistrationSubmissionResult,
  VehicleRegisterInput,
  VehicleView,
} from '../entities';

/**
 * Contrato del repositorio de registro (capa domain). Las implementaciones concretas viven en
 * `data/` (HTTP real o stub). Los consumidores (use cases / hooks) dependen de esta abstracción,
 * no de HTTP directo (SOLID-D). Todos los pasos del wizard cablean a endpoints REALES del
 * driver-bff (datos personales, vehículo, documentos, licencia y biometría).
 */
export interface RegistrationRepository {
  /**
   * Cierre del alta. Los datos personales, el vehículo, los documentos y la biometría ya se
   * persistieron en sus respectivos pasos contra los endpoints reales; aquí solo se confirma el
   * cierre del wizard devolviendo `in_review` como compuerta local hasta que `GET /drivers/me`
   * refleje el estado real del servidor (no hay un endpoint "submit registration" único).
   */
  submit(draft: RegistrationDraft): Promise<RegistrationSubmissionResult>;

  /** PATCH /drivers/me/personal — persiste los datos personales (PII) del conductor. */
  updatePersonalData(input: PersonalDataInput): Promise<PersonalDataView>;

  /** POST /drivers/vehicles — alta self-service del vehículo (queda PENDING_REVIEW). */
  registerVehicle(input: VehicleRegisterInput): Promise<VehicleView>;

  /** GET /drivers/vehicles — vehículos del conductor (rehidratación; más recientes primero). */
  listVehicles(): Promise<VehicleView[]>;

  /**
   * GET /drivers/active-vehicle — vehículo ACTIVO (el que el conductor opera; server-authoritative).
   * `null` si no tiene ninguno operable (el BFF responde 204). El dispatch deriva el tipo de ESTE.
   */
  getActiveVehicle(): Promise<VehicleView | null>;

  /** PATCH /drivers/active-vehicle — selecciona el vehículo activo del conductor. Devuelve el activo. */
  setActiveVehicle(vehicleId: string): Promise<VehicleView>;

  /** GET /drivers/me/documents — documentos reales del conductor (con `simpleStatus` para chips). */
  listDocuments(): Promise<RegistrationDocumentView[]>;

  /** POST /drivers/me/documents — registra/actualiza un documento del alta (queda en revisión). */
  submitDocument(input: RegistrationDocumentRequest): Promise<RegistrationDocumentView>;

  /** POST /drivers/onboard — alta de licencia del conductor (`driverOnboardRequest`). */
  onboardLicense(input: LicenseOnboardInput): Promise<void>;

  /** POST /drivers/biometric/enroll — enrola el rostro de referencia (foto en base64). */
  enrollBiometric(input: BiometricEnrollInput): Promise<BiometricEnrollResult>;
}
