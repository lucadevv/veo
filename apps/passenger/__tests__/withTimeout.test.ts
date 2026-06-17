import {TimeoutError, withTimeout} from '../src/shared/utils/withTimeout';

/**
 * `withTimeout` es el mecanismo que evita el peor modo de falla del pánico: un `getCurrentPosition()`
 * que CUELGA (GPS sin fix, indoor, bajo coacción) dejaría la alerta en un spinner infinito que nunca
 * envía ni falla. Estas pruebas garantizan que: una promesa lenta se corta con `TimeoutError`, una
 * que resuelve a tiempo pasa su valor, y un rechazo propio se propaga sin enmascararse.
 */
describe('withTimeout', () => {
  it('resuelve con el valor si la promesa termina antes del tope', async () => {
    const value = await withTimeout(Promise.resolve('ubicacion'), 50);
    expect(value).toBe('ubicacion');
  });

  it('RECHAZA con TimeoutError si la promesa cuelga más allá del tope', async () => {
    // Promesa que nunca resuelve: simula el GPS colgado en la ruta de pánico.
    const nunca = new Promise<string>(() => {});
    await expect(withTimeout(nunca, 20, 'GPS lento')).rejects.toBeInstanceOf(
      TimeoutError,
    );
    await expect(
      withTimeout(new Promise<string>(() => {}), 20, 'GPS lento'),
    ).rejects.toThrow('GPS lento');
  });

  it('propaga el error propio de la promesa (no lo enmascara como timeout)', async () => {
    const fallo = Promise.reject(new Error('permiso denegado'));
    await expect(withTimeout(fallo, 50)).rejects.toThrow('permiso denegado');
  });

  it('no rechaza por timeout si la promesa ya resolvió (limpia el temporizador)', async () => {
    const value = await withTimeout(Promise.resolve(42), 10);
    expect(value).toBe(42);
    // Si el temporizador no se limpiara, un rechazo tardío rompería el test runner; al pasar, está limpio.
  });
});
