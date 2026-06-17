import type { MobileSessionUser } from '@veo/api-client';
import { prefsStore } from '../../storage/mmkv';
import { useSessionStore } from '../sessionStore';
import { useRegistrationStore } from '../../../features/registration/presentation/state/registrationStore';

/** Clave MMKV donde el wizard de alta persiste su progreso (espeja `registrationStore`). */
const REGISTRATION_PREF_KEY = 'pref.registration.v1';

/** Pone el store de alta en un estado "sucio" como el de un conductor ya aprobado (con PII). */
function makeRegistrationDirty(): void {
  useRegistrationStore.setState({
    status: 'approved',
    statusResolvedFromBackend: true,
    currentStep: 4,
    personal: { fullName: 'Carlos Quispe Mamani', dni: '70123456', birthdate: '15/08/1990' },
    vehicle: {
      type: 'CAR',
      plate: 'ABC-123',
      year: '2021',
      modelSpecId: 'spec-1',
      brand: 'Honda',
      model: 'CB 190R',
    },
    documents: [{ type: 'LICENSE', status: 'uploaded' }],
    faceCapture: { ref: 'face-ref-123', score: 0.99, capturedAt: '2026-05-30T10:00:00.000Z' },
  });
}

const sampleUser = { id: 'drv-1', phone: '+51999999999' } as unknown as MobileSessionUser;

describe('sessionStore · reset de alta en cierre de sesión', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useRegistrationStore.getState().reset();
    useSessionStore.setState({
      status: 'authenticated',
      accessToken: 'a',
      refreshToken: 'r',
      user: sampleUser,
      expired: false,
    });
  });

  it('clearSession() (logout) resetea el alta: sin PII ni status heredado para el siguiente conductor', () => {
    makeRegistrationDirty();
    const removeSpy = jest.spyOn(prefsStore, 'remove');

    useSessionStore.getState().clearSession();

    const reg = useRegistrationStore.getState();
    // SEGURIDAD: el siguiente conductor arranca LIMPIO (no entra a tabs por un `approved` heredado).
    expect(reg.status).toBe('not_started');
    expect(reg.statusResolvedFromBackend).toBe(false);
    expect(reg.currentStep).toBe(1);
    // Sin fuga de PII de la cuenta anterior.
    expect(reg.personal).toEqual({ fullName: '', dni: '', birthdate: '' });
    expect(reg.faceCapture).toBeNull();
    // La clave persistida del alta se borra del almacén de preferencias.
    expect(removeSpy).toHaveBeenCalledWith(REGISTRATION_PREF_KEY);
    // La sesión queda como logout (no expiración).
    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(useSessionStore.getState().expired).toBe(false);
  });

  it('expireSession() (refresh fallido) también resetea el alta y marca expiración', () => {
    makeRegistrationDirty();
    const removeSpy = jest.spyOn(prefsStore, 'remove');

    useSessionStore.getState().expireSession();

    const reg = useRegistrationStore.getState();
    expect(reg.status).toBe('not_started');
    expect(reg.statusResolvedFromBackend).toBe(false);
    expect(reg.personal).toEqual({ fullName: '', dni: '', birthdate: '' });
    expect(removeSpy).toHaveBeenCalledWith(REGISTRATION_PREF_KEY);
    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(useSessionStore.getState().expired).toBe(true);
  });
});
