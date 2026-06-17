import { describe, it, expect } from 'vitest';
import { OfferingId, FleetDocumentType } from '@veo/shared-types';
import { certificationTypesForEnabledOfferings, documentTypeLabel } from './certifications';

const off = (id: string, enabled: boolean) => ({ id, enabled });

/**
 * Gate "oculto hasta vender" (B5-vert): el form de certs solo ofrece las credenciales que exige una vertical
 * HABILITADA. Es reflejo de UX, no autorización (el backend acepta cualquier cert por API).
 */
describe('certificationTypesForEnabledOfferings · gate de certs por vertical habilitada', () => {
  it('sin verticales habilitadas → ninguna cert (las credenciales quedan ocultas)', () => {
    const offerings = [off(OfferingId.VEO_ECONOMICO, true), off(OfferingId.VEO_AMBULANCE, false)];
    expect(certificationTypesForEnabledOfferings(offerings)).toEqual([]);
  });

  it('ambulancia HABILITADA → aparece su credencial (AMBULANCE_OPERATOR)', () => {
    const offerings = [off(OfferingId.VEO_ECONOMICO, true), off(OfferingId.VEO_AMBULANCE, true)];
    expect(certificationTypesForEnabledOfferings(offerings)).toEqual([FleetDocumentType.AMBULANCE_OPERATOR]);
  });

  it('varias verticales habilitadas → todas sus credenciales (sin duplicar)', () => {
    const offerings = [
      off(OfferingId.VEO_AMBULANCE, true),
      off(OfferingId.VEO_TOW, true),
      off(OfferingId.VEO_MECHANIC, false), // apagada → su cert NO aparece
    ];
    expect(certificationTypesForEnabledOfferings(offerings).sort()).toEqual(
      [FleetDocumentType.AMBULANCE_OPERATOR, FleetDocumentType.TOW_OPERATOR].sort(),
    );
  });

  it('las ofertas RIDE habilitadas no aportan certs (no exigen credenciales)', () => {
    const offerings = [off(OfferingId.VEO_ECONOMICO, true), off(OfferingId.VEO_CONFORT, true)];
    expect(certificationTypesForEnabledOfferings(offerings)).toEqual([]);
  });

  it('id desconocido (oferta más nueva que el admin-web) se ignora sin romper', () => {
    expect(certificationTypesForEnabledOfferings([off('veo_futura', true)])).toEqual([]);
  });
});

describe('documentTypeLabel · nombre legible de credenciales en el form', () => {
  it('las certs de vertical tienen nombre legible', () => {
    expect(documentTypeLabel(FleetDocumentType.AMBULANCE_OPERATOR)).toBe('Operador de ambulancia');
    expect(documentTypeLabel(FleetDocumentType.TOW_OPERATOR)).toBe('Operador de grúa');
    expect(documentTypeLabel(FleetDocumentType.MECHANIC_CERT)).toBe('Certificación de mecánico');
  });

  it('los docs base se muestran crudos (consistencia con el form actual)', () => {
    expect(documentTypeLabel(FleetDocumentType.LICENSE_A1)).toBe('LICENSE_A1');
    expect(documentTypeLabel(FleetDocumentType.SOAT)).toBe('SOAT');
  });
});
