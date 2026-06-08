import { Container, createToken } from '../src/core/di/container';
import { buildContainer } from '../src/core/di/registry';
import { TOKENS } from '../src/core/di/tokens';

describe('Container (DI)', () => {
  it('resuelve una dependencia registrada', () => {
    const container = new Container();
    const token = createToken<{ value: number }>('test.value');
    container.register(token, () => ({ value: 42 }));

    expect(container.resolve(token).value).toBe(42);
  });

  it('cachea la instancia como singleton', () => {
    const container = new Container();
    const token = createToken<{ id: number }>('test.singleton');
    let calls = 0;
    container.register(token, () => ({ id: ++calls }));

    const first = container.resolve(token);
    const second = container.resolve(token);

    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it('lanza un error claro si el token no está registrado', () => {
    const container = new Container();
    const token = createToken<number>('test.missing');

    expect(() => container.resolve(token)).toThrow(/no registrada/);
  });

  it('inyecta dependencias entre fábricas (DIP)', () => {
    const container = new Container();
    const dep = createToken<number>('test.dep');
    const consumer = createToken<{ doubled: number }>('test.consumer');

    container.register(dep, () => 21);
    container.register(consumer, (c) => ({ doubled: c.resolve(dep) * 2 }));

    expect(container.resolve(consumer).doubled).toBe(42);
  });
});

describe('buildContainer (cableado real)', () => {
  it('resuelve repositorios reales (impl data bajo el token de la abstracción domain)', () => {
    const container = buildContainer();
    const authRepository = container.resolve(TOKENS.authRepository);

    expect(typeof authRepository.requestOtp).toBe('function');
    expect(typeof authRepository.verifyOtp).toBe('function');
  });

  it('resuelve casos de uso que dependen de la abstracción del repositorio', () => {
    const container = buildContainer();
    const requestOtp = container.resolve(TOKENS.requestOtpUseCase);

    expect(typeof requestOtp.execute).toBe('function');
  });
});
