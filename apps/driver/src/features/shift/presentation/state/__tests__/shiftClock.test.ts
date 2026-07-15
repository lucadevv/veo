import type { KeyValueStore } from '../../../../../core/storage/mmkv';
import { PrefKey } from '../../../../../core/storage/keys';
import { consumeShiftStartedAt, recordShiftStart } from '../shiftClock';

/** Fake en memoria del `KeyValueStore` para probar el reloj sin MMKV real. */
function fakeStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getString: (k) => data.get(k),
    setString: (k, v) => {
      data.set(k, v);
    },
    getObject: <T>(k: string) => {
      const raw = data.get(k);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    setObject: (k, v) => {
      data.set(k, JSON.stringify(v));
    },
    remove: (k) => {
      data.delete(k);
    },
    clear: () => {
      data.clear();
    },
  };
}

describe('shiftClock (persistencia del reloj de turno)', () => {
  it('sella y luego consume la marca de inicio (round-trip)', () => {
    const store = fakeStore();
    recordShiftStart(store, 1_700_000_000_000);
    expect(store.getString(PrefKey.ShiftStartedAt)).toBe('1700000000000');
    expect(consumeShiftStartedAt(store)).toBe(1_700_000_000_000);
  });

  it('consumir BORRA la marca (no se lee dos veces)', () => {
    const store = fakeStore();
    recordShiftStart(store, 42_000);
    expect(consumeShiftStartedAt(store)).toBe(42_000);
    expect(consumeShiftStartedAt(store)).toBeNull();
    expect(store.getString(PrefKey.ShiftStartedAt)).toBeUndefined();
  });

  it('degrada a null si no hay marca o es ilegible', () => {
    const store = fakeStore();
    expect(consumeShiftStartedAt(store)).toBeNull();
    store.setString(PrefKey.ShiftStartedAt, 'no-es-un-numero');
    expect(consumeShiftStartedAt(store)).toBeNull();
  });
});
