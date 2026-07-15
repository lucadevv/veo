import { RegistrationStep } from '../../../domain';

/**
 * LOTE B (reagrupación 4→3 pasos): `migrateLegacyStep` (privada) remapea el `currentStep` de un snapshot
 * legacy (`v1`, 4 pasos: 1=Datos · 2=Vehículo · 3=Documentos · 4=KYC) al layout `v2` (3 pasos: 1=Conductor ·
 * 2=Vehículo · 3=KYC). Corre por el PATH PÚBLICO: `loadPersisted` la aplica al CARGAR el módulo del store
 * cuando `schemaVersion < REGISTRATION_SCHEMA_VERSION` (o está ausente), y el `currentStep` resultante
 * inicializa el store. Se testea por ese path (sin exportar la privada): se mockea `prefsStore.getObject`
 * para devolver un snapshot `v1` y se reimporta el store en un grafo de módulos aislado (`jest.isolateModules`
 * + `jest.doMock` del almacén MMKV) para reejecutar la rehidratación, verificando el `currentStep` migrado.
 */
describe('registrationStore · migración de snapshots legacy (v1 4 pasos → v2 3 pasos) al rehidratar', () => {
  /**
   * Reimporta el store en un grafo aislado con `prefsStore.getObject` devolviendo un snapshot legacy `v1`
   * (sin `schemaVersion` = v1) con el `currentStep` dado, y devuelve el `currentStep` con el que arrancó el
   * store (ya pasado por `migrateLegacyStep` dentro de `loadPersisted`).
   */
  const currentStepAfterRehydrate = (legacyStep: number): number => {
    let step = 0;
    jest.isolateModules(() => {
      jest.doMock('../../../../../core/storage/mmkv', () => ({
        prefsStore: {
          getObject: jest.fn().mockReturnValue({ currentStep: legacyStep }),
          setObject: jest.fn(),
          remove: jest.fn(),
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useRegistrationStore } = require('../registrationStore');
      step = useRegistrationStore.getState().currentStep;
    });
    return step;
  };

  afterEach(() => {
    jest.resetModules();
  });

  it('v1 step=3 (Documentos viejo, ya no existe) → Vehículo (2)', () => {
    expect(currentStepAfterRehydrate(3)).toBe(RegistrationStep.VEHICLE);
  });

  it('v1 step=4 (KYC viejo) → IdentityVerification (3)', () => {
    expect(currentStepAfterRehydrate(4)).toBe(RegistrationStep.IDENTITY_VERIFICATION);
  });

  it('v1 step=1/2 (in-range, sin cambio de índice) → passthrough', () => {
    expect(currentStepAfterRehydrate(1)).toBe(RegistrationStep.PERSONAL_DATA);
    expect(currentStepAfterRehydrate(2)).toBe(RegistrationStep.VEHICLE);
  });

  it('v1 step fuera de rango (0 o 9) → degradación segura a PERSONAL_DATA (1)', () => {
    expect(currentStepAfterRehydrate(0)).toBe(RegistrationStep.PERSONAL_DATA);
    expect(currentStepAfterRehydrate(9)).toBe(RegistrationStep.PERSONAL_DATA);
  });
});
