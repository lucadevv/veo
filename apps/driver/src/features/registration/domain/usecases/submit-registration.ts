import type { RegistrationRepository } from '../repositories/registration-repository';
import type { RegistrationDraft, RegistrationSubmissionResult } from '../entities';

/** Error de dominio: el borrador no está completo para enviarse. */
export class IncompleteRegistrationError extends Error {
  constructor() {
    super('El registro está incompleto');
    this.name = 'IncompleteRegistrationError';
  }
}

/**
 * Caso de uso: envía el alta del conductor. Valida invariantes mínimas del borrador (datos
 * presentes y rostro capturado) antes de delegar en el repositorio. La validación fina de formato
 * (DNI, placa, etc.) es responsabilidad del backend.
 */
export class SubmitRegistrationUseCase {
  constructor(private readonly repository: RegistrationRepository) {}

  execute(draft: RegistrationDraft): Promise<RegistrationSubmissionResult> {
    if (!isDraftComplete(draft)) {
      return Promise.reject(new IncompleteRegistrationError());
    }
    return this.repository.submit(draft);
  }
}

/** Verifica que el borrador tenga los campos obligatorios de los 4 pasos. */
export function isDraftComplete(draft: RegistrationDraft): boolean {
  const { personal, vehicle, faceCaptureRef } = draft;
  return Boolean(
    personal.fullName.trim() &&
    personal.dni.trim() &&
    personal.birthdate.trim() &&
    vehicle.plate.trim() &&
    vehicle.brand.trim() &&
    vehicle.year.trim() &&
    vehicle.model.trim() &&
    faceCaptureRef,
  );
}
