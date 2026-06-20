import type { HttpClient } from '@veo/api-client';
import {
  addDocumentRequest,
  driverBiometricEnrollRequest,
  driverBiometricEnrollResult,
  driverLivenessChallengeResponse,
  driverDocument,
  driverOnboardRequest,
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

  listDocuments(): Promise<RegistrationDocumentView[]> {
    return this.http.get('/drivers/me/documents', { schema: driverDocumentList });
  }

  submitDocument(input: RegistrationDocumentRequest): Promise<RegistrationDocumentView> {
    // Valida el body con el contrato antes de enviarlo (descarta campos no permitidos).
    const body = addDocumentRequest.parse(input);
    return this.http.post('/drivers/me/documents', { body, schema: driverDocument });
  }

  async onboardLicense(input: LicenseOnboardInput): Promise<void> {
    const body = driverOnboardRequest.parse(input);
    // El backend responde el perfil agregado; lo validamos pero no necesitamos su valor aquí.
    await this.http.post('/drivers/onboard', { body, schema: driverProfileView });
  }

  getLivenessChallenge(): Promise<LivenessChallenge> {
    // Reto de liveness ACTIVO de un solo uso para el enrolamiento del alta. Mismo schema que el reto
    // del turno (`driverLivenessChallengeResponse`), pero distinto endpoint (GET, sin body).
    return this.http.get('/drivers/me/biometric/liveness/challenge', {
      schema: driverLivenessChallengeResponse,
    });
  }

  enrollBiometric(input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
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
