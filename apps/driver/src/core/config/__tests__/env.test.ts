import {env} from '../env';

describe('env', () => {
  it('aplica defaults válidos cuando react-native-config está vacío', () => {
    expect(env.APP_ENV).toBe('development');
    // La REST del driver-bff siempre lleva el prefijo /api/v1.
    expect(env.DRIVER_BFF_URL).toMatch(/\/api\/v1$/);
    // El origen del socket NO lleva prefijo REST (el namespace /driver se añade aparte).
    expect(env.DRIVER_BFF_WS_URL).not.toMatch(/\/api\/v1$/);
  });

  it('expone URLs parseables', () => {
    expect(() => new URL(env.DRIVER_BFF_URL)).not.toThrow();
    expect(() => new URL(env.DRIVER_BFF_WS_URL)).not.toThrow();
  });
});
