import {PrefKey} from '../../../../../core/storage/keys';
import type {KeyValueStore} from '../../../../../core/storage/mmkv';
import {prefsStore} from '../../../../../core/storage/mmkv';
import {
  currentVehicleType,
  readPersistedVehicleType,
  useVehicleTypeStore,
} from '../vehicleTypeStore';

/** Almacén en memoria que implementa el puerto `KeyValueStore` (sin MMKV nativo). */
function fakeStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getString: key => data.get(key),
    setString: (key, value) => void data.set(key, value),
    getObject: <T,>(key: string) => {
      const raw = data.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    setObject: (key, value) => void data.set(key, JSON.stringify(value)),
    remove: key => void data.delete(key),
    clear: () => data.clear(),
  };
}

describe('readPersistedVehicleType', () => {
  it('lee el tipo guardado', () => {
    expect(readPersistedVehicleType(fakeStore({[PrefKey.VehicleType]: 'MOTO'}))).toBe('MOTO');
  });

  it('degrada a CAR si no hay nada guardado o está corrupto', () => {
    expect(readPersistedVehicleType(fakeStore())).toBe('CAR');
    expect(readPersistedVehicleType(fakeStore({[PrefKey.VehicleType]: 'xxx'}))).toBe('CAR');
  });
});

describe('useVehicleTypeStore', () => {
  beforeEach(() => {
    useVehicleTypeStore.setState({vehicleType: 'CAR'});
    jest.clearAllMocks();
  });

  it('cambia el tipo activo y lo persiste en preferencias', () => {
    const setString = jest.spyOn(prefsStore, 'setString');

    useVehicleTypeStore.getState().setVehicleType('MOTO');

    expect(useVehicleTypeStore.getState().vehicleType).toBe('MOTO');
    expect(currentVehicleType()).toBe('MOTO');
    expect(setString).toHaveBeenCalledWith(PrefKey.VehicleType, 'MOTO');
  });
});
