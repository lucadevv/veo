import { describe, it, expect } from 'vitest';
import { PanicStatus } from '@veo/shared-types';
import { PANIC_TABS, PANIC_FILTER_ALL, DEFAULT_PANIC_TAB } from './panics';

const DOMAIN = Object.values(PanicStatus) as string[];

/**
 * Contrato del panel de pánicos (SAFETY-CRITICAL). El server valida `status` con `@IsIn(PANIC_STATUSES)`;
 * cualquier tab cuyo valor de dominio no sea un `PanicStatus` real → 400 y la pantalla queda ciega.
 * Estos tests blindan esa frontera para que no vuelva el bug del tab 'OPEN' (regresión del 400).
 */
describe('PANIC_TABS · contrato cliente↔server de los filtros de pánico', () => {
  it('todo valor de DOMINIO es un PanicStatus válido (lo que el server acepta con @IsIn)', () => {
    const domainValues = PANIC_TABS.map((t) => t.value).filter((v) => v !== PANIC_FILTER_ALL);
    for (const v of domainValues) {
      expect(DOMAIN).toContain(v);
    }
  });

  it("'OPEN' ya NO es un valor de tab (regresión del 400 que cegaba pánicos activos)", () => {
    expect(PANIC_TABS.map((t) => t.value)).not.toContain('OPEN');
  });

  it('el único valor NO-dominio es el sentinel ALL (sin filtro, lo elimina cleanQuery)', () => {
    const nonDomain = PANIC_TABS.map((t) => t.value).filter((v) => !DOMAIN.includes(v));
    expect(nonDomain).toEqual([PANIC_FILTER_ALL]);
  });

  it('el tab por defecto es TRIGGERED: la cola urgente de pánicos sin atender', () => {
    expect(DEFAULT_PANIC_TAB).toBe(PanicStatus.TRIGGERED);
  });
});
