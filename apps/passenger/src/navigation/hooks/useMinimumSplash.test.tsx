import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {DEFAULT_MIN_SPLASH_MS, useMinimumSplash} from './useMinimumSplash';

/**
 * Especificación del PISO de duración del splash de marca. El gate es un PISO, no un techo:
 * garantiza que el splash se vea un mínimo aunque la sesión resuelva al instante, y NO demora más.
 *
 * Se sondea el hook con un `Probe` montado en `react-test-renderer` (mismo patrón que el resto del
 * repo, sin `@testing-library`), avanzando timers falsos.
 */

/** Monta el hook en una sonda y devuelve getter del último valor + control de ciclo de vida. */
function renderHook(ms?: number): {
  current: () => boolean;
  rerender: (nextMs: number) => void;
  unmount: () => void;
} {
  let last = false;
  function Probe({value}: {value?: number}): null {
    last = useMinimumSplash(value);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe value={ms} />);
  });
  return {
    current: () => last,
    rerender: (nextMs: number) =>
      act(() => renderer.update(<Probe value={nextMs} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

describe('useMinimumSplash · piso de duración del splash', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('arranca pendiente (true) y sigue pendiente justo antes del piso', () => {
    const hook = renderHook(2000);
    expect(hook.current()).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(hook.current()).toBe(true);
    hook.unmount();
  });

  it('deja de estar pendiente (false) al cumplirse el piso exacto', () => {
    const hook = renderHook(2000);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(hook.current()).toBe(false);
    hook.unmount();
  });

  it('con ms = 0 (reduce-motion) nace ya cumplido: nunca bloquea', () => {
    const hook = renderHook(0);
    expect(hook.current()).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(hook.current()).toBe(false);
    hook.unmount();
  });

  it('usa el piso de marca por defecto (~1.9s)', () => {
    const hook = renderHook();
    expect(hook.current()).toBe(true);

    act(() => {
      jest.advanceTimersByTime(DEFAULT_MIN_SPLASH_MS - 1);
    });
    expect(hook.current()).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(hook.current()).toBe(false);
    hook.unmount();
  });

  it('congela el piso del primer montaje: cambiar ms en caliente no reinicia ni alarga', () => {
    const hook = renderHook(2000);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    // Sube el piso a la mitad del camino: NO debe reiniciar el timer original.
    hook.rerender(5000);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(hook.current()).toBe(false);
    hook.unmount();
  });

  it('limpia el timer al desmontar (sin update tras unmount)', () => {
    const hook = renderHook(2000);
    expect(hook.current()).toBe(true);
    hook.unmount();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // El objetivo es que NO haya warning de "update on unmounted component".
    expect(hook.current()).toBe(true);
  });
});
