import { FleetDocumentType } from '@veo/shared-types';
import {
  registrationDocTypeToBackend,
  type RegistrationDocumentType,
} from '../entities';

/**
 * Guarda de regresión del P0: la etiqueta interna del wizard DEBE mapear al `FleetDocumentType`
 * canónico de `@veo/shared-types` que valida el presign del driver-bff (`@IsEnum(FleetDocumentType)`).
 * El caso decisivo es `VEHICLE_REGISTRATION` → `PROPERTY_CARD`: antes devolvía el string mágico
 * `VEHICLE_REGISTRATION`, que NO existe en el enum → presign 400 al subir la tarjeta de propiedad.
 */
describe('registrationDocTypeToBackend · alinea la etiqueta del wizard al FleetDocumentType canónico', () => {
  it('mapea los tres documentos del alta a LICENSE_A1 / SOAT / PROPERTY_CARD', () => {
    expect(registrationDocTypeToBackend('LICENSE')).toBe(FleetDocumentType.LICENSE_A1);
    expect(registrationDocTypeToBackend('SOAT')).toBe(FleetDocumentType.SOAT);
    // Regresión P0: la tarjeta de propiedad es PROPERTY_CARD, NO el string mágico VEHICLE_REGISTRATION.
    expect(registrationDocTypeToBackend('VEHICLE_REGISTRATION')).toBe(FleetDocumentType.PROPERTY_CARD);
  });

  it('nunca devuelve el valor que el presign rechazaría (VEHICLE_REGISTRATION no es un FleetDocumentType)', () => {
    const fleetValues: readonly string[] = Object.values(FleetDocumentType);
    const labels: RegistrationDocumentType[] = ['LICENSE', 'SOAT', 'VEHICLE_REGISTRATION'];
    for (const label of labels) {
      const wire = registrationDocTypeToBackend(label);
      expect(fleetValues).toContain(wire);
      expect(wire).not.toBe('VEHICLE_REGISTRATION');
    }
  });
});
