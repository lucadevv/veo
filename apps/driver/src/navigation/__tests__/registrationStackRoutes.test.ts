import { RegistrationStep } from '../../features/registration/domain';
import {
  STEP_ROUTES,
  buildResumeRoutes,
  isRegistrationStep,
  resolveInitialRoute,
} from '../registrationStackRoutes';

/**
 * Reconstrucción de la pila del wizard al REANUDAR (fix del back muerto). En native-stack
 * `initialRouteName` monta UNA sola pantalla: al resumir con `currentStep ∈ {2,3,4}` la pila quedaba
 * `[pasoN]` y un `goBack` moría con "GO_BACK was not handled". `buildResumeRoutes` deriva la pila
 * `[PersonalData … pasoN]` (índice = paso N) de la fuente TIPADA (`RegistrationStep`/`STEP_ROUTES`),
 * sin strings mágicos, para que el back camine por los pasos completados hasta el paso 1.
 */
describe('registrationStackRoutes · reconstrucción de la pila al reanudar', () => {
  it('resuelve la pantalla inicial de cada paso desde STEP_ROUTES (1..4), default PersonalData', () => {
    expect(resolveInitialRoute(RegistrationStep.PERSONAL_DATA)).toBe('PersonalData');
    expect(resolveInitialRoute(RegistrationStep.VEHICLE)).toBe('Vehicle');
    expect(resolveInitialRoute(RegistrationStep.DOCUMENTS)).toBe('Documents');
    expect(resolveInitialRoute(RegistrationStep.IDENTITY_VERIFICATION)).toBe('IdentityVerification');
    // Paso fuera de rango (estado corrupto): cae a la raíz, nunca a `undefined`.
    expect(resolveInitialRoute(0)).toBe('PersonalData');
    expect(resolveInitialRoute(99)).toBe('PersonalData');
  });

  it('NO reconstruye en el paso 1 ni en pasos inválidos (no hay pila debajo que sembrar)', () => {
    expect(buildResumeRoutes(RegistrationStep.PERSONAL_DATA)).toBeNull();
    expect(buildResumeRoutes(0)).toBeNull();
    expect(buildResumeRoutes(99)).toBeNull();
  });

  it('reconstruye [PersonalData, Vehicle] con índice 1 al reanudar en el paso 2', () => {
    expect(buildResumeRoutes(RegistrationStep.VEHICLE)).toEqual({
      index: 1,
      routes: [{ name: 'PersonalData' }, { name: 'Vehicle' }],
    });
  });

  it('reconstruye [PersonalData, Vehicle, Documents] con índice 2 al reanudar en el paso 3', () => {
    // Caso del bug reproducido por el dueño: resumir en Documentos (paso 3). La pila reconstruida deja
    // dos pasos DEBAJO (1 y 2), así que el back desde Documentos retrocede a Vehículo, no muere.
    expect(buildResumeRoutes(RegistrationStep.DOCUMENTS)).toEqual({
      index: 2,
      routes: [{ name: 'PersonalData' }, { name: 'Vehicle' }, { name: 'Documents' }],
    });
  });

  it('reconstruye los 4 pasos con índice 3 al reanudar en el paso 4 (KYC)', () => {
    expect(buildResumeRoutes(RegistrationStep.IDENTITY_VERIFICATION)).toEqual({
      index: 3,
      routes: [
        { name: 'PersonalData' },
        { name: 'Vehicle' },
        { name: 'Documents' },
        { name: 'IdentityVerification' },
      ],
    });
  });

  it('el índice de destino SIEMPRE apunta al último de la pila (paso N = top visible)', () => {
    // Invariante: el paso resumido queda ARRIBA (lo que `initialRouteName` ya pintó) y la pila se
    // siembra debajo → sin salto/flash. `index === routes.length - 1` en todos los casos válidos.
    for (const step of [RegistrationStep.VEHICLE, RegistrationStep.DOCUMENTS, RegistrationStep.IDENTITY_VERIFICATION]) {
      const resume = buildResumeRoutes(step);
      expect(resume).not.toBeNull();
      expect(resume?.index).toBe((resume?.routes.length ?? 0) - 1);
      // La pantalla del top es la del paso resumido (derivada de STEP_ROUTES, sin strings mágicos).
      expect(resume?.routes[resume.index]?.name).toBe(STEP_ROUTES[step]);
    }
  });

  it('narrowing isRegistrationStep: solo 1..4 son pasos válidos del wizard', () => {
    expect(isRegistrationStep(RegistrationStep.PERSONAL_DATA)).toBe(true);
    expect(isRegistrationStep(RegistrationStep.IDENTITY_VERIFICATION)).toBe(true);
    expect(isRegistrationStep(0)).toBe(false);
    expect(isRegistrationStep(5)).toBe(false);
  });
});
