import {
  VehicleType,
  type BiometricEnrollInput,
  type BiometricEnrollResult,
  type LicenseOnboardInput,
  type PersonalDataInput,
  type PersonalDataView,
  type RegistrationDocumentRequest,
  type RegistrationDocumentView,
  type RegistrationDraft,
  type RegistrationRepository,
  type RegistrationSubmissionResult,
  type ResubmitResult,
  type VehicleModelOption,
  type VehicleModelRequestInput,
  type VehicleModelRequestResult,
  type VehicleRegisterInput,
  type VehicleView,
} from '../../domain';

/**
 * Implementación STUB del repositorio de registro (solo desarrollo/pruebas y fallback).
 *
 * La implementación de producción es `HttpRegistrationRepository` (registrada en el contenedor de
 * DI), que cablea documentos/licencia/biometría a los endpoints reales del driver-bff. Este stub se
 * mantiene como doble para pruebas y como red de seguridad: acepta cualquier entrada y devuelve
 * valores plausibles para que el flujo de UI quede demostrable de extremo a extremo.
 *
 * No usa HTTP directo en presentación (regla SOLID-D): la presentación depende de la interfaz
 * `RegistrationRepository`, no de esta clase.
 */
export class StubRegistrationRepository implements RegistrationRepository {
  async submit(_draft: RegistrationDraft): Promise<RegistrationSubmissionResult> {
    await delay(600);
    return { status: 'in_review' };
  }

  async updatePersonalData(input: PersonalDataInput): Promise<PersonalDataView> {
    await delay(400);
    return { legalName: input.legalName, dni: input.dni, birthDate: input.birthDate };
  }

  async registerVehicle(input: VehicleRegisterInput): Promise<VehicleView> {
    await delay(500);
    return {
      id: `dev-vehicle-${Date.now()}`,
      plate: input.plate,
      // B5-2: con modelSpecId el backend snapshotea make/model del catálogo; el stub no tiene catálogo,
      // así que cae a lo que venga o a un placeholder plausible.
      make: input.make ?? 'Catálogo',
      model: input.model ?? 'Modelo',
      year: input.year,
      vehicleType: input.vehicleType,
      status: 'PENDING_REVIEW',
      docStatus: 'PENDING_REVIEW',
    };
  }

  async listVehicleModels(params: { vehicleType: VehicleType }): Promise<VehicleModelOption[]> {
    await delay(200);
    // Catálogo de muestra para el flujo de UI local (sin backend). Filtra por tipo como el real.
    const all: VehicleModelOption[] = [
      {
        id: 'dev-yaris',
        make: 'Toyota',
        model: 'Yaris',
        yearFrom: 2017,
        yearTo: 2024,
        vehicleType: VehicleType.CAR,
        seats: 5,
      },
      {
        id: 'dev-i10',
        make: 'Hyundai',
        model: 'i10',
        yearFrom: 2018,
        yearTo: 2024,
        vehicleType: VehicleType.CAR,
        seats: 5,
      },
      {
        id: 'dev-bajaj',
        make: 'Bajaj',
        model: 'RE',
        yearFrom: 2018,
        yearTo: 2024,
        vehicleType: VehicleType.MOTO,
        seats: 3,
      },
    ];
    return all.filter((m) => m.vehicleType === params.vehicleType);
  }

  async requestVehicleModel(input: VehicleModelRequestInput): Promise<VehicleModelRequestResult> {
    await delay(400);
    return {
      id: `dev-model-req-${Date.now()}`,
      make: input.make,
      model: input.model,
      status: 'PENDING_REVIEW',
    };
  }

  async listVehicles(): Promise<VehicleView[]> {
    await delay(200);
    return [];
  }

  async getActiveVehicle(): Promise<VehicleView | null> {
    await delay(200);
    return null;
  }

  async setActiveVehicle(vehicleId: string): Promise<VehicleView> {
    await delay(300);
    return {
      id: vehicleId,
      plate: 'DEV-000',
      make: 'Dev',
      model: 'Stub',
      year: 2020,
      vehicleType: VehicleType.CAR,
      status: 'ACTIVE',
      docStatus: 'VALID',
    };
  }

  async listDocuments(): Promise<RegistrationDocumentView[]> {
    await delay(200);
    return [];
  }

  async submitDocument(input: RegistrationDocumentRequest): Promise<RegistrationDocumentView> {
    await delay(400);
    return {
      type: input.type,
      // VEHICLE_PHOTO no trae número → '' (la vista lo expone como string no-null).
      documentNumber: input.documentNumber ?? '',
      status: 'PENDING_REVIEW',
      simpleStatus: 'en_revision',
      expiresAt: input.expiresAt ?? null,
      ok: false,
      // Recién enviado: no rechazado → sin motivo.
      rejectionReason: null,
    };
  }

  async onboardLicense(_input: LicenseOnboardInput): Promise<void> {
    await delay(400);
  }

  async enrollBiometric(_input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
    await delay(500);
    return { enrolled: true, enrolledAt: new Date().toISOString() };
  }

  async resubmit(): Promise<ResubmitResult> {
    await delay(400);
    return { id: `dev-driver-${Date.now()}`, backgroundCheckStatus: 'PENDING' };
  }
}

/** Pequeña espera para simular la latencia de red (solo en el stub). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instancia compartida del repositorio stub (doble de pruebas / fallback local). */
export const stubRegistrationRepository = new StubRegistrationRepository();
