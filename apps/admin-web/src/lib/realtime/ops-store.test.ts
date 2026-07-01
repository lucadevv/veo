import { beforeEach, describe, expect, it } from 'vitest';
import type { DriverLocationMsg } from '@veo/api-client';
import { DRIVER_STALE_MS, useOpsStore } from './ops-store';

/**
 * Fix de raíz del marker fantasma: sin evento `driver:offline`, el store poda por FRESCURA. Estos
 * tests cubren la lógica pura (sin React): la poda usa el reloj LOCAL de recepción (drift-free), acota
 * el crecimiento del record y es un no-op ESTABLE por referencia cuando nada venció (cero re-render).
 */
function loc(driverId: string): DriverLocationMsg {
  return {
    tripId: `trip-${driverId}`,
    driverId,
    point: { lat: -12.0464, lon: -77.0428 },
    heading: 90,
    speedKph: 30,
    at: new Date().toISOString(),
  };
}

describe('ops-store · poda de conductores stale', () => {
  beforeEach(() => {
    useOpsStore.setState({ drivers: {} });
  });

  it('upsertDriver sella el instante LOCAL de recepción (no el `at` del backend)', () => {
    const t0 = 1_000_000;
    useOpsStore.getState().upsertDriver(loc('d1'), t0);
    const entry = useOpsStore.getState().drivers['d1'];
    expect(entry?.receivedAt).toBe(t0);
    expect(entry?.msg.driverId).toBe('d1');
  });

  it('poda al conductor cuya última muestra excede la ventana de frescura', () => {
    const t0 = 1_000_000;
    useOpsStore.getState().upsertDriver(loc('offline'), t0);
    // Un tick posterior a t0 + ventana ⇒ el conductor quedó stale y se saca.
    useOpsStore.getState().pruneStaleDrivers(t0 + DRIVER_STALE_MS + 1);
    expect(useOpsStore.getState().drivers['offline']).toBeUndefined();
  });

  it('mantiene al conductor que aún está dentro de la ventana', () => {
    const t0 = 1_000_000;
    useOpsStore.getState().upsertDriver(loc('fresh'), t0);
    useOpsStore.getState().pruneStaleDrivers(t0 + DRIVER_STALE_MS - 1);
    expect(useOpsStore.getState().drivers['fresh']?.msg.driverId).toBe('fresh');
  });

  it('es no-op ESTABLE por referencia cuando nada venció (no dispara re-render)', () => {
    const t0 = 1_000_000;
    useOpsStore.getState().upsertDriver(loc('fresh'), t0);
    const before = useOpsStore.getState().drivers;
    useOpsStore.getState().pruneStaleDrivers(t0 + 1_000);
    // Misma identidad de objeto ⇒ zustand no notifica, selectores/useMemo no corren.
    expect(useOpsStore.getState().drivers).toBe(before);
  });

  it('acota el crecimiento del record: solo sobreviven los frescos', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 500; i++) useOpsStore.getState().upsertDriver(loc(`old-${i}`), t0);
    // 3 llegan tarde (siguen vivos al momento del sweep).
    const tSweep = t0 + DRIVER_STALE_MS + 1;
    for (let i = 0; i < 3; i++) useOpsStore.getState().upsertDriver(loc(`live-${i}`), tSweep);

    useOpsStore.getState().pruneStaleDrivers(tSweep);
    expect(Object.keys(useOpsStore.getState().drivers)).toHaveLength(3);
  });
});
