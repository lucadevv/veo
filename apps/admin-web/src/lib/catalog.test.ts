import { describe, it, expect } from 'vitest';
import { OfferingId } from '@veo/shared-types';
import type { CatalogOverride } from '@/lib/api/schemas';
import { offeringLabel, withOverride } from './catalog';

/**
 * El display map del admin (B5-4.1). Contrato: TODA oferta del catálogo canónico resuelve a un nombre
 * legible en el panel (no su id crudo), incluidas las verticales B5-4 que el admin VE para desbloquearlas.
 * La exhaustividad real la garantiza `satisfies Record<OfferingId, string>` en compile-time; este test la
 * documenta a runtime y cubre la degradación honesta de un id desconocido.
 */
describe('offeringLabel · nombres del catálogo en el panel admin', () => {
  it('TODA oferta del catálogo resuelve a un nombre legible (no su id crudo)', () => {
    for (const id of Object.values(OfferingId)) {
      expect(offeringLabel(id), `falta el nombre legible de ${id}`).not.toBe(id);
    }
  });

  it('las verticales B5-4 tienen su nombre legible (no "veo_ambulance")', () => {
    expect(offeringLabel(OfferingId.VEO_AMBULANCE)).toBe('VEO Ambulancia');
    expect(offeringLabel(OfferingId.VEO_TOW)).toBe('VEO Grúa');
    expect(offeringLabel(OfferingId.VEO_MECHANIC)).toBe('VEO Mecánico');
    expect(offeringLabel(OfferingId.VEO_ECONOMICO_EV)).toBe('VEO Económico Eléctrico');
  });

  it('degradación honesta: un id desconocido (server más nuevo que el admin) cae al id crudo', () => {
    expect(offeringLabel('veo_futura')).toBe('veo_futura');
  });
});

/**
 * withOverride · poda de overrides "redundantes" comparando contra el defaultEnabled REAL (BUGFIX del unlock
 * de verticales). El bug era asumir default=enabled:true para todas → habilitar una vertical (default false)
 * se podaba y la feature pagable no persistía. Cubre los 4 cuadrantes habilitar/deshabilitar × RIDE/vertical.
 */
describe('withOverride · persistencia del override por defaultEnabled real', () => {
  const ov = (o: Partial<CatalogOverride> & { id: string; enabled: boolean }): CatalogOverride => o;

  it('BUGFIX: habilitar una VERTICAL (defaultEnabled:false) PERSISTE el override (no se poda)', () => {
    const out = withOverride([], ov({ id: OfferingId.VEO_AMBULANCE, enabled: true }));
    expect(out).toEqual([{ id: OfferingId.VEO_AMBULANCE, enabled: true }]);
  });

  it('habilitar una RIDE (defaultEnabled:true) sin pin/precio se OMITE (es el default, no ensucia la DB)', () => {
    const out = withOverride([], ov({ id: OfferingId.VEO_ECONOMICO, enabled: true }));
    expect(out).toEqual([]);
  });

  it('deshabilitar una RIDE PERSISTE (enabled:false ≠ default true)', () => {
    const out = withOverride([], ov({ id: OfferingId.VEO_ECONOMICO, enabled: false }));
    expect(out).toEqual([{ id: OfferingId.VEO_ECONOMICO, enabled: false }]);
  });

  it('deshabilitar una VERTICAL se OMITE (enabled:false === default false → vuelve al estado base)', () => {
    const out = withOverride([], ov({ id: OfferingId.VEO_AMBULANCE, enabled: false }));
    expect(out).toEqual([]);
  });

  it('con pin de modo/precio PERSISTE aunque enabled coincida con el default', () => {
    const out = withOverride([], ov({ id: OfferingId.VEO_ECONOMICO, enabled: true, multiplier: 1.5 }));
    expect(out).toEqual([{ id: OfferingId.VEO_ECONOMICO, enabled: true, multiplier: 1.5 }]);
  });

  it('preserva los overrides de las OTRAS ofertas (replace wholesale)', () => {
    const base = [ov({ id: OfferingId.VEO_MOTO, enabled: false })];
    const out = withOverride(base, ov({ id: OfferingId.VEO_AMBULANCE, enabled: true }));
    expect(out).toContainEqual({ id: OfferingId.VEO_MOTO, enabled: false });
    expect(out).toContainEqual({ id: OfferingId.VEO_AMBULANCE, enabled: true });
  });

  it('reemplaza el override previo de la MISMA oferta (no duplica)', () => {
    const base = [ov({ id: OfferingId.VEO_AMBULANCE, enabled: true })];
    const out = withOverride(base, ov({ id: OfferingId.VEO_AMBULANCE, enabled: false }));
    expect(out).toEqual([]); // deshabilitar vertical → vuelve al default → se poda, sin duplicado
  });
});
