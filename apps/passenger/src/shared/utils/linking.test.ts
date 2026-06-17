import {Linking} from 'react-native';
import {openExternalUrl} from './linking';

/**
 * openExternalUrl: el helper que resuelve el CRASH de "unhandled promise rejection" al abrir un esquema
 * externo (deepLink Yape) en iOS cuando la app no está instalada / el esquema es desconocido.
 */
describe('openExternalUrl', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('abre la URL y devuelve true cuando el sistema la acepta', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await expect(openExternalUrl('yapeapp:oneshot/abc')).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('yapeapp:oneshot/abc');
  });

  it('CAPTURA el rechazo de openURL (Yape no instalada / esquema desconocido) y devuelve false', async () => {
    // En iOS, openURL RECHAZA si no puede abrir el esquema → sin catch sería un crash. Acá NO debe lanzar.
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('no se pudo abrir el esquema'));
    await expect(openExternalUrl('yapeapp:oneshot/abc')).resolves.toBe(false);
  });

  it('URL vacía/nula → false sin tocar Linking (nada que abrir)', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    spy.mockClear(); // el preset de RN puede traer openURL como mock con historial previo.
    await expect(openExternalUrl(null)).resolves.toBe(false);
    await expect(openExternalUrl(undefined)).resolves.toBe(false);
    await expect(openExternalUrl('')).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
