import { env } from '../src/core/config/env';

describe('env', () => {
  it('expone la base REST del public-bff con el prefijo /api/v1', () => {
    expect(env.publicBffUrl).toMatch(/\/api\/v1$/);
    expect(() => new URL(env.publicBffUrl)).not.toThrow();
  });

  it('expone el host de Socket.IO del public-bff (sin /api/v1)', () => {
    expect(env.publicBffWsUrl).not.toMatch(/\/api\/v1$/);
    expect(() => new URL(env.publicBffWsUrl)).not.toThrow();
  });

  it('tiene defaults seguros sin .env (firebase deshabilitado, entorno dev)', () => {
    expect(env.firebaseEnabled).toBe(false);
    expect(env.environment).toBe('development');
  });
});
