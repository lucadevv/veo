import { FleetDocumentType } from '@veo/shared-types';
import { RegistrationStep, correctionStepForRejection } from '../entities';

/**
 * U4: `correctionStepForRejection` deriva el paso de corrección del EJE REAL del rechazo (documentos del
 * operador, KYC/biometría, antecedentes) — NO del paso 1 por omisión cuando le rechazaron la
 * selfie/antecedentes. Distingue los ejes por TIPO (`RejectionAxes`), sin strings mágicos.
 */
describe('correctionStepForRejection · deriva el paso del EJE real del rechazo', () => {
  it('rechazo de BIOMETRÍA/identidad (KYC) sin documento derivable → paso KYC (IDENTITY_VERIFICATION)', () => {
    expect(
      correctionStepForRejection({
        rejectedDocTypes: [],
        kycRejected: true,
        backgroundCheckRejected: false,
      }),
    ).toBe(RegistrationStep.IDENTITY_VERIFICATION);
  });

  it('rechazo de ANTECEDENTES sin documento derivable → paso KYC (IDENTITY_VERIFICATION)', () => {
    expect(
      correctionStepForRejection({
        rejectedDocTypes: [],
        kycRejected: false,
        backgroundCheckRejected: true,
      }),
    ).toBe(RegistrationStep.IDENTITY_VERIFICATION);
  });

  it('rechazo de un DOC del conductor → paso de ese doc (Conductor), AUNQUE haya rechazo de KYC', () => {
    // El documento concreto manda: es lo más temprano y accionable. El KYC se revalida al reenviar.
    expect(
      correctionStepForRejection({
        rejectedDocTypes: [FleetDocumentType.DNI],
        kycRejected: true,
        backgroundCheckRejected: false,
      }),
    ).toBe(RegistrationStep.PERSONAL_DATA);
  });

  it('rechazo de un DOC del vehículo → paso Vehículo', () => {
    expect(
      correctionStepForRejection({
        rejectedDocTypes: [FleetDocumentType.SOAT],
        kycRejected: false,
        backgroundCheckRejected: false,
      }),
    ).toBe(RegistrationStep.VEHICLE);
  });

  it('sin ningún eje derivable (degradación honesta) → null (el llamador decide el fallback)', () => {
    expect(
      correctionStepForRejection({
        rejectedDocTypes: [],
        kycRejected: false,
        backgroundCheckRejected: false,
      }),
    ).toBeNull();
  });
});
