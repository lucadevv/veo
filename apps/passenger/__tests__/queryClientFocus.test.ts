/**
 * F8 · El focusManager de React Query queda cableado al AppState de RN al cargar el módulo del
 * queryClient. En RN no hay evento `focus`/`visibilitychange` del DOM, así que sin esto los polls
 * (p.ej. el recibo del cierre post-viaje) no re-evaluarían al volver de background.
 *
 * Verificamos el CONTRATO del wiring (estable frente a internals de React Query): nuestro
 * `setEventListener` registra un listener de AppState que, al volver a "active", llama al `handleFocus`
 * que React Query nos pasa con `true`, y con `false` al ir a background.
 */
import { AppState } from 'react-native';

describe('queryClient · focusManager ↔ AppState', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('al volver a "active" propaga focused=true (y false en background)', () => {
    let querySetup: ((handleFocus: (focused: boolean) => void) => () => void) | undefined;
    let appStateHandler: ((s: string) => void) | undefined;

    const addSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event: string, handler: (s: string) => void) => {
        if (event === 'change') appStateHandler = handler;
        return { remove: jest.fn() } as never;
      });

    // Aislamos el registro de módulos para que el queryClient y el focusManager espiado compartan la
    // MISMA instancia de @tanstack/react-query (el spy debe aplicar al singleton que ve el módulo).
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- spy sobre el singleton aislado
      const { focusManager } = require('@tanstack/react-query');
      jest.spyOn(focusManager, 'setEventListener').mockImplementation((setup: typeof querySetup) => {
        querySetup = setup;
      });
      // Cargar el módulo dispara el wiring (focusManager.setEventListener → AppState.addEventListener).
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- carga aislada del módulo bajo test
      require('../src/core/query/queryClient');
    });

    expect(querySetup).toBeDefined();

    // Ejecutamos el setup con un handleFocus espía (lo que React Query haría internamente).
    const handleFocus = jest.fn();
    querySetup?.(handleFocus);

    expect(addSpy).toHaveBeenCalledWith('change', expect.any(Function));
    expect(appStateHandler).toBeDefined();

    appStateHandler?.('active');
    expect(handleFocus).toHaveBeenLastCalledWith(true);

    appStateHandler?.('background');
    expect(handleFocus).toHaveBeenLastCalledWith(false);
  });
});
