import type { HttpClient } from '@veo/api-client';
import {
  ApiError,
  addDocumentRequest,
  driverBiometricEnrollRequest,
  driverBiometricEnrollResult,
  driverLivenessChallengeResponse,
  driverDocument,
  driverOnboardRequest,
  driverOnboardResult,
  driverPersonalData,
  driverPersonalDataRequest,
  driverProfileView,
  driverModelRequestView,
  driverResubmitResult,
  driverVehicleList,
  driverVehicleModelList,
  driverVehicleView,
  registerVehicleRequest,
  requestVehicleModelRequest,
} from '@veo/api-client';
import { z } from 'zod';
import { mapProfileToRegistrationStatus } from '../../domain';
import type {
  BiometricEnrollInput,
  BiometricEnrollResult,
  LivenessChallenge,
  LicenseOnboardInput,
  PersonalDataInput,
  PersonalDataView,
  RegistrationDocumentRequest,
  RegistrationDocumentView,
  RegistrationDraft,
  RegistrationRepository,
  RegistrationSubmissionResult,
  ResubmitResult,
  VehicleModelOption,
  VehicleModelRequestInput,
  VehicleModelRequestResult,
  VehicleRegisterInput,
  VehicleType,
  VehicleView,
} from '../../domain';

/** El listado de documentos es un arreglo de `driverDocument`. */
const driverDocumentList = z.array(driverDocument);

/**
 * Implementación HTTP del repositorio de registro contra el driver-bff. Cablea todos los pasos del
 * wizard a endpoints reales (datos personales, vehículo, documentos, licencia y biometría) siguiendo
 * el patrón de `HttpDocumentsRepository`/`HttpProfileRepository`: valida el body con el contrato y
 * parsea la respuesta con su schema Zod.
 */
export class HttpRegistrationRepository implements RegistrationRepository {
  constructor(private readonly http: HttpClient) {}

  async submit(_draft: RegistrationDraft): Promise<RegistrationSubmissionResult> {
    // Los datos del alta ya se persistieron en cada paso (personal/vehículo/documentos/biometría) y
    // NO hay un endpoint "submit registration" único. Derivamos el estado real del servidor con la
    // MISMA fuente de verdad que el gate: `GET /drivers/me` mapeado por `mapProfileToRegistrationStatus`
    // (no inventamos `in_review`). El `RootNavigator` reconcilia luego en cada arranque con el gate
    // (`useRegistrationGate`), así que este valor solo siembra el estado inicial tras cerrar el wizard.
    const profile = await this.http.get('/drivers/me', { schema: driverProfileView });
    return { status: mapProfileToRegistrationStatus(profile) };
  }

  updatePersonalData(input: PersonalDataInput): Promise<PersonalDataView> {
    const body = driverPersonalDataRequest.parse(input);
    return this.http.patch('/drivers/me/personal', { body, schema: driverPersonalData });
  }

  registerVehicle(input: VehicleRegisterInput): Promise<VehicleView> {
    const body = registerVehicleRequest.parse(input);
    return this.http.post('/drivers/vehicles', { body, schema: driverVehicleView });
  }

  listVehicleModels(params: { vehicleType: VehicleType }): Promise<VehicleModelOption[]> {
    return this.http.get('/drivers/vehicle-models', {
      query: { vehicleType: params.vehicleType },
      schema: driverVehicleModelList,
    });
  }

  requestVehicleModel(input: VehicleModelRequestInput): Promise<VehicleModelRequestResult> {
    const body = requestVehicleModelRequest.parse(input);
    return this.http.post('/drivers/vehicle-models', { body, schema: driverModelRequestView });
  }

  listVehicles(): Promise<VehicleView[]> {
    return this.http.get('/drivers/vehicles', { schema: driverVehicleList });
  }

  async getActiveVehicle(): Promise<VehicleView | null> {
    // 204 (sin vehículo operable) → el HttpClient devuelve undefined; lo mapeamos a null.
    const active = (await this.http.get('/drivers/active-vehicle', {
      schema: driverVehicleView,
    })) as VehicleView | undefined;
    return active ?? null;
  }

  setActiveVehicle(vehicleId: string): Promise<VehicleView> {
    return this.http.patch('/drivers/active-vehicle', {
      body: { vehicleId },
      schema: driverVehicleView,
    });
  }

  async listDocuments(): Promise<RegistrationDocumentView[]> {
    // Un conductor NUEVO (recién pasó OTP) aún NO tiene perfil en el backend hasta el
    // `PATCH /drivers/me/personal`, así que este endpoint responde 404 "No existe un perfil de
    // conductor para este usuario". Eso NO es un error de la app: es la MISMA filosofía con la que el
    // gate trata el 404 de `GET /drivers/me` (conductor nuevo ⇒ wizard, no error). Conductor sin perfil
    // = sin documentos ⇒ lista VACÍA. Se detecta por status 404 TIPADO (`ApiError`), no por el texto.
    // Cualquier otro error (red/5xx/401) se PROPAGA: no lo tragamos (no fingimos "sin documentos").
    try {
      return await this.http.get('/drivers/me/documents', { schema: driverDocumentList });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return [];
      }
      throw e;
    }
  }

  submitDocument(input: RegistrationDocumentRequest): Promise<RegistrationDocumentView> {
    // Valida el body con el contrato antes de enviarlo (descarta campos no permitidos).
    const body = addDocumentRequest.parse(input);
    return this.http.post('/drivers/me/documents', { body, schema: driverDocument });
  }

  async onboardLicense(input: LicenseOnboardInput): Promise<void> {
    const body = driverOnboardRequest.parse(input);
    // `POST /drivers/onboard` responde el perfil FINO (`{ driverId, backgroundCheckStatus }`), NO el
    // perfil agregado de `GET /drivers/me`. Validamos con el schema que matchea esa forma real; el
    // valor no se usa aquí (la app deriva el estado del gate con `GET /drivers/me`).
    await this.http.post('/drivers/onboard', { body, schema: driverOnboardResult });
  }

  // DEUDA(liveness-removido): el KYC del alta pasó a UNA SELFIE simple (Lote 2). Este método quedó SIN
  // CONSUMIDORES en la app (el enroll ya no usa reto/frames). Se conserva porque el endpoint del backend
  // aún existe. Gatillo: borrar este método (+ `LivenessChallenge` / `driverLivenessChallengeResponse`)
  // cuando el backend confirme que retira `GET /drivers/me/biometric/liveness/challenge`.
  getLivenessChallenge(): Promise<LivenessChallenge> {
    return this.http.get('/drivers/me/biometric/liveness/challenge', {
      schema: driverLivenessChallengeResponse,
    });
  }

  enrollBiometric(input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
    // Body NUEVO (Lote 2): una sola foto base64 (`{ photo }`), sin challengeId/frames.
    const body = driverBiometricEnrollRequest.parse(input);
    return this.http.post('/drivers/biometric/enroll', {
      body,
      schema: driverBiometricEnrollResult,
    });
  }

  resubmit(): Promise<ResubmitResult> {
    // Sin body: identity resuelve el conductor desde la identidad propagada. Valida la respuesta.
    return this.http.post('/drivers/me/resubmit', { body: {}, schema: driverResubmitResult });
  }
}
