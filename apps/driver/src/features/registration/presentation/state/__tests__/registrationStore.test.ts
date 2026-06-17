import { useRegistrationStore } from '../registrationStore';

describe('registrationStore · forceWizard (404 de GET /drivers/me)', () => {
  beforeEach(() => {
    useRegistrationStore.getState().reset();
  });

  it('descarta un `approved` espurio heredado y fuerza el wizard (not_started)', () => {
    // Simula la fuga del bug #1: el store quedó en `approved` de un conductor anterior.
    useRegistrationStore.setState({ status: 'approved', statusResolvedFromBackend: false });

    useRegistrationStore.getState().forceWizard();

    const state = useRegistrationStore.getState();
    expect(state.status).toBe('not_started');
    // El 404 ES una respuesta definitiva del backend: marca resuelto (no se queda "resolviendo").
    expect(state.statusResolvedFromBackend).toBe(true);
  });

  it('conserva el progreso local en curso (in_progress) para no expulsar al conductor del wizard', () => {
    useRegistrationStore.setState({ status: 'in_progress', statusResolvedFromBackend: false });

    useRegistrationStore.getState().forceWizard();

    const state = useRegistrationStore.getState();
    expect(state.status).toBe('in_progress');
    expect(state.statusResolvedFromBackend).toBe(true);
  });

  it('descarta también in_review/rejected heredados a favor del wizard', () => {
    for (const stale of ['in_review', 'rejected'] as const) {
      useRegistrationStore.getState().reset();
      useRegistrationStore.setState({ status: stale });
      useRegistrationStore.getState().forceWizard();
      expect(useRegistrationStore.getState().status).toBe('not_started');
    }
  });
});
