import type {
  BiometricEnrollInput,
  BiometricEnrollResult,
  CheckDniInput,
  CheckDniResult,
  LicenseOnboardInput,
  PersonalDataInput,
  PersonalDataView,
  RegistrationDocumentRequest,
  RegistrationDocumentView,
  RegistrationDraft,
  RegistrationSubmissionResult,
  ResubmitResult,
  VehicleModelOption,
  VehicleModelRequestInput,
  VehicleModelRequestResult,
  VehicleRegisterInput,
  VehicleType,
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

  /**
   * POST /drivers/me/check-dni — chequea si el DNI escaneado YA está registrado en OTRA cuenta
   * (blind index `dni_hash`). Se consulta ANTES de crear el driver + subir el DNI (Lote 1 · eager):
   * `{ exists: true }` ⇒ el alta corta con "DNI ya registrado" sin subir nada.
   */
  checkDni(input: CheckDniInput): Promise<CheckDniResult>;

  /** POST /drivers/vehicles — alta self-service del vehículo (queda PENDING_REVIEW). */
  registerVehicle(input: VehicleRegisterInput): Promise<VehicleView>;

  /**
   * GET /drivers/vehicle-models — catálogo curado de modelos APROBADOS para el selector del alta (B5-2).
   * Filtra por tipo (un mototaxista solo ve motos). El catálogo es chico; la búsqueda fina es client-side.
   */
  listVehicleModels(params: { vehicleType: VehicleType }): Promise<VehicleModelOption[]>;

  /**
   * POST /drivers/vehicle-models — el conductor SOLICITA un modelo que no está en el catálogo (B5-2.c).
   * Queda PENDING_REVIEW hasta que el operador lo apruebe; el conductor recibe la confirmación.
   */
  requestVehicleModel(input: VehicleModelRequestInput): Promise<VehicleModelRequestResult>;

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

  /**
   * POST /drivers/biometric/enroll — enrola el rostro de referencia con UNA SELFIE: `{ photo }` (JPEG
   * base64, sin prefijo `data:`). El backend valida que la imagen contenga exactamente un rostro claro.
   */
  enrollBiometric(input: BiometricEnrollInput): Promise<BiometricEnrollResult>;

  /**
   * POST /drivers/me/resubmit — reenvío a revisión tras un rechazo. El conductor RECHAZADO corrigió sus
   * datos y vuelve a la cola de aprobación (REJECTED → PENDING). El backend valida la transición.
   */
  resubmit(): Promise<ResubmitResult>;
}
