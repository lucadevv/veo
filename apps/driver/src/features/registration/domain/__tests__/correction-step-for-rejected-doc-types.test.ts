import { FleetDocumentType } from '@veo/shared-types';
import { RegistrationStep, correctionStepForRejectedDocTypes } from '../entities';

/**
 * LOTE B (reagrupación por DUEÑO del documento): `correctionStepForRejectedDocTypes` deriva el PRIMER
 * paso del wizard a corregir a partir de los `FleetDocumentType` rechazados por el operador. La doc del
 * CONDUCTOR (DNI + LICENSE_A1) vive en el paso 1 (PERSONAL_DATA); la doc del VEHÍCULO (PROPERTY_CARD +
 * SOAT + VEHICLE_PHOTO) en el paso 2 (VEHICLE). Se prioriza el paso MÁS TEMPRANO presente; si ningún
 * tipo es derivable (rechazo de antecedentes/KYC, sin documento), devuelve `null`.
 */
describe('correctionStepForRejectedDocTypes · mapea doc-types rechazados al paso de corrección por dueño', () => {
  it('rechazo de doc del CONDUCTOR (DNI o LICENSE_A1) → paso Conductor (PERSONAL_DATA)', () => {
    expect(correctionStepForRejectedDocTypes([FleetDocumentType.DNI])).toBe(
      RegistrationStep.PERSONAL_DATA,
    );
    expect(correctionStepForRejectedDocTypes([FleetDocumentType.LICENSE_A1])).toBe(
      RegistrationStep.PERSONAL_DATA,
    );
  });

  it('rechazo de doc del VEHÍCULO (PROPERTY_CARD, SOAT o VEHICLE_PHOTO) → paso Vehículo (VEHICLE)', () => {
    expect(correctionStepForRejectedDocTypes([FleetDocumentType.PROPERTY_CARD])).toBe(
      RegistrationStep.VEHICLE,
    );
    expect(correctionStepForRejectedDocTypes([FleetDocumentType.SOAT])).toBe(
      RegistrationStep.VEHICLE,
    );
    expect(correctionStepForRejectedDocTypes([FleetDocumentType.VEHICLE_PHOTO])).toBe(
      RegistrationStep.VEHICLE,
    );
  });

  it('combinación CONDUCTOR + VEHÍCULO (DNI + SOAT) → el paso MÁS TEMPRANO (Conductor)', () => {
    expect(
      correctionStepForRejectedDocTypes([FleetDocumentType.SOAT, FleetDocumentType.DNI]),
    ).toBe(RegistrationStep.PERSONAL_DATA);
    expect(
      correctionStepForRejectedDocTypes([
        FleetDocumentType.VEHICLE_PHOTO,
        FleetDocumentType.LICENSE_A1,
      ]),
    ).toBe(RegistrationStep.PERSONAL_DATA);
  });

  it('ningún tipo derivable a un paso (lista vacía o rechazo sin documento) → null', () => {
    expect(correctionStepForRejectedDocTypes([])).toBeNull();
    // Un `FleetDocumentType` que no es del alta (no pertenece a Conductor ni a Vehículo) → null.
    expect(correctionStepForRejectedDocTypes(['SOME_UNRELATED_DOC_TYPE'])).toBeNull();
  });
});
