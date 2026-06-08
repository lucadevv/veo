import { describe, it, expect } from 'vitest';
import { ConflictError } from '@veo/utils';
import { assertContactQuota, assertContactsCooldown } from './contacts.rules';

const COOLDOWN_MS = 24 * 3_600_000;

describe('contactos · cupo máximo (BR-I06: máx 3)', () => {
  it('permite agregar mientras hay menos de 3', () => {
    expect(() => assertContactQuota(0, 3)).not.toThrow();
    expect(() => assertContactQuota(2, 3)).not.toThrow();
  });

  it('rechaza al alcanzar el máximo de 3', () => {
    expect(() => assertContactQuota(3, 3)).toThrow(ConflictError);
  });

  it('rechaza si por alguna razón ya hay más del máximo', () => {
    expect(() => assertContactQuota(4, 3)).toThrow(ConflictError);
  });
});

describe('contactos · cool-down de modificación (24h)', () => {
  it('permite modificar si nunca se modificó antes', () => {
    expect(() => assertContactsCooldown(null, COOLDOWN_MS)).not.toThrow();
  });

  it('bloquea si la última modificación fue hace menos de 24h', () => {
    const now = 1_000_000_000_000;
    const lastMod = new Date(now - 1_000); // hace 1 segundo
    expect(() => assertContactsCooldown(lastMod, COOLDOWN_MS, now)).toThrow(ConflictError);
  });

  it('permite modificar una vez transcurrido el cool-down', () => {
    const now = 1_000_000_000_000;
    const lastMod = new Date(now - COOLDOWN_MS - 1); // hace más de 24h
    expect(() => assertContactsCooldown(lastMod, COOLDOWN_MS, now)).not.toThrow();
  });

  it('justo en el límite (=24h) ya permite modificar', () => {
    const now = 1_000_000_000_000;
    const lastMod = new Date(now - COOLDOWN_MS);
    expect(() => assertContactsCooldown(lastMod, COOLDOWN_MS, now)).not.toThrow();
  });
});
