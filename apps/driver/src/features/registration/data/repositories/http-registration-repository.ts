import type {
  HttpClient} from '@veo/api-client';
import {
  addDocumentRequest,
  driverBiometricEnrollRequest,
  driverBiometricEnrollResult,
  driverDocument,
  driverOnboardRequest,
  driverPersonalData,
  driverPersonalDataRequest,
  driverProfileView,
  driverVehicleList,
  driverVehicleView,
  registerVehicleRequest,
} from '@veo/api-client';
import {z} from 'zod';
import {mapProfileToRegistrationStatus} from '../../domain';
import type {
  BiometricEnrollInput,
  BiometricEnrollResult,
  LicenseOnboardInput,
  PersonalDataInput,
  PersonalDataView,
  RegistrationDocumentRequest,
  RegistrationDocumentView,
  RegistrationDraft,
  RegistrationRepository,
  RegistrationSubmissionResult,
  VehicleRegisterInput,
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
    const profile = await this.http.get('/drivers/me', {schema: driverProfileView});
    return {status: mapProfileToRegistrationStatus(profile)};
  }

  updatePersonalData(input: PersonalDataInput): Promise<PersonalDataView> {
    const body = driverPersonalDataRequest.parse(input);
    return this.http.patch('/drivers/me/personal', {body, schema: driverPersonalData});
  }

  registerVehicle(input: VehicleRegisterInput): Promise<VehicleView> {
    const body = registerVehicleRequest.parse(input);
    return this.http.post('/drivers/vehicles', {body, schema: driverVehicleView});
  }

  listVehicles(): Promise<VehicleView[]> {
    return this.http.get('/drivers/vehicles', {schema: driverVehicleList});
  }

  async getActiveVehicle(): Promise<VehicleView | null> {
    // 204 (sin vehículo operable) → el HttpClient devuelve undefined; lo mapeamos a null.
    const active = (await this.http.get('/drivers/active-vehicle', {schema: driverVehicleView})) as
      | VehicleView
      | undefined;
    return active ?? null;
  }

  setActiveVehicle(vehicleId: string): Promise<VehicleView> {
    return this.http.patch('/drivers/active-vehicle', {body: {vehicleId}, schema: driverVehicleView});
  }

  listDocuments(): Promise<RegistrationDocumentView[]> {
    return this.http.get('/drivers/me/documents', {schema: driverDocumentList});
  }

  submitDocument(input: RegistrationDocumentRequest): Promise<RegistrationDocumentView> {
    // Valida el body con el contrato antes de enviarlo (descarta campos no permitidos).
    const body = addDocumentRequest.parse(input);
    return this.http.post('/drivers/me/documents', {body, schema: driverDocument});
  }

  async onboardLicense(input: LicenseOnboardInput): Promise<void> {
    const body = driverOnboardRequest.parse(input);
    // El backend responde el perfil agregado; lo validamos pero no necesitamos su valor aquí.
    await this.http.post('/drivers/onboard', {body, schema: driverProfileView});
  }

  enrollBiometric(input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
    const body = driverBiometricEnrollRequest.parse(input);
    return this.http.post('/drivers/biometric/enroll', {body, schema: driverBiometricEnrollResult});
  }
}
