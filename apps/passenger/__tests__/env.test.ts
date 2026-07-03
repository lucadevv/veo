import {env} from '../src/core/config/env';

describe('env', () => {
  it('expone la base REST del public-bff con el prefijo /api/v1', () => {
    expect(env.publicBffUrl).toMatch(/\/api\/v1$/);
    expect(() => new URL(env.publicBffUrl)).not.toThrow();
  });

  it('expone el host de Socket.IO del public-bff (sin /api/v1)', () => {
    expect(env.publicBffWsUrl).not.toMatch(/\/api\/v1$/);
    expect(() => new URL(env.publicBffWsUrl)).not.toThrow();
  });

  // `env.environment` dejó de existir con el auto-sanado de env (2124d920): el objeto expone solo
  // URLs/flags reales. El default seguro que queda por afirmar es firebase deshabilitado sin .env.
  it('tiene defaults seguros sin .env (firebase deshabilitado)', () => {
    expect(env.firebaseEnabled).toBe(false);
  });
});
