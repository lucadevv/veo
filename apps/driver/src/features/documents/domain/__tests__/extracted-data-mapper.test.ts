import { FleetDocumentType } from '@veo/shared-types';
import {
  parsedDniToExtracted,
  parsedLicenseToExtracted,
  parsedPropertyCardToExtracted,
  parsedSoatToExtracted,
} from '../ocr/extracted-data-mapper';
import type {
  ParsedDni,
  ParsedLicense,
  ParsedPropertyCard,
  ParsedSoat,
} from '../ocr/parsed-document';

/**
 * Pruebas del MAPPER `ParsedX → ExtractedDocumentData` (Lote 1 · onboarding sin-formularios). El mapper
 * es el seam load-bearing del contrato cliente→backend: discrimina por `FleetDocumentType`, TRADUCE los
 * nombres divergentes (parser↔contrato) y OMITE lo que el OCR no leyó. Si esto falla, el backend tira 400
 * (`forbidNonWhitelisted`) o se envía data inventada.
 */
describe('extracted-data-mapper · ParsedX → ExtractedDocumentData (degradación honesta)', () => {
  describe('DNI · parsedDniToExtracted', () => {
    it('mapea los 3 campos y TRADUCE birthDate → birthdate (minúscula del contrato)', () => {
      const parsed: ParsedDni = {
        fullName: 'QUISPE MAMANI CARLOS',
        documentNumber: '70123456',
        birthDate: '1990-03-15',
      };
      expect(parsedDniToExtracted(parsed)).toEqual({
        type: FleetDocumentType.DNI,
        fullName: 'QUISPE MAMANI CARLOS',
        documentNumber: '70123456',
        birthdate: '1990-03-15',
      });
    });

    it('OMITE los campos que el OCR no leyó (no inyecta undefined)', () => {
      const result = parsedDniToExtracted({ documentNumber: '70123456' });
      expect(result).toEqual({ type: FleetDocumentType.DNI, documentNumber: '70123456' });
      expect(result).not.toHaveProperty('fullName');
      expect(result).not.toHaveProperty('birthdate');
    });

    it('un parse vacío produce SOLO el discriminante (señal de "nada leído" para el gating)', () => {
      expect(parsedDniToExtracted({})).toEqual({ type: FleetDocumentType.DNI });
    });
  });

  describe('SOAT · parsedSoatToExtracted', () => {
    it('mapea policyNumber + expiresAt con el discriminante SOAT', () => {
      const parsed: ParsedSoat = { policyNumber: 'POL-2026-0099', expiresAt: '2027-01-31' };
      expect(parsedSoatToExtracted(parsed)).toEqual({
        type: FleetDocumentType.SOAT,
        policyNumber: 'POL-2026-0099',
        expiresAt: '2027-01-31',
      });
    });

    it('OMITE expiresAt cuando el OCR solo leyó la póliza', () => {
      const result = parsedSoatToExtracted({ policyNumber: 'POL-1' });
      expect(result).toEqual({ type: FleetDocumentType.SOAT, policyNumber: 'POL-1' });
      expect(result).not.toHaveProperty('expiresAt');
    });
  });

  describe('Licencia · parsedLicenseToExtracted', () => {
    it('TRADUCE number → documentNumber y MAPEA category (clase A auto / clase B moto)', () => {
      const parsed: ParsedLicense = {
        number: 'Q12345678',
        category: 'A-I',
        expiresAt: '2028-06-30',
      };
      const result = parsedLicenseToExtracted(parsed);
      expect(result).toEqual({
        type: FleetDocumentType.LICENSE_A1,
        documentNumber: 'Q12345678',
        expiresAt: '2028-06-30',
        category: 'A-I',
      });
    });

    it('MAPEA la categoría de CLASE B (moto)', () => {
      const result = parsedLicenseToExtracted({ number: 'F73694046', category: 'B-IIb' });
      expect(result.category).toBe('B-IIb');
    });

    it('OMITE lo no leído (parse vacío → solo discriminante)', () => {
      expect(parsedLicenseToExtracted({})).toEqual({ type: FleetDocumentType.LICENSE_A1 });
    });
  });

  describe('Tarjeta de propiedad · parsedPropertyCardToExtracted', () => {
    it('mapea todos los campos incl. energySource (combustible de la TIVe · ADR-017 §1.8)', () => {
      const parsed: ParsedPropertyCard = {
        plate: 'ABC-123',
        make: 'TOYOTA',
        model: 'YARIS',
        year: 2019,
        mtcCategory: 'M1',
        energySource: 'GASOLINE_90',
      };
      expect(parsedPropertyCardToExtracted(parsed)).toEqual({
        type: FleetDocumentType.PROPERTY_CARD,
        plate: 'ABC-123',
        make: 'TOYOTA',
        model: 'YARIS',
        year: 2019,
        mtcCategory: 'M1',
        energySource: 'GASOLINE_90',
      });
    });

    it('OMITE energySource cuando el OCR no lo leyó (degradación honesta)', () => {
      const result = parsedPropertyCardToExtracted({ plate: 'XYZ-789', mtcCategory: 'N1' });
      expect(result).toEqual({
        type: FleetDocumentType.PROPERTY_CARD,
        plate: 'XYZ-789',
        mtcCategory: 'N1',
      });
      expect(result).not.toHaveProperty('energySource');
    });

    it('parse vacío → solo el discriminante', () => {
      expect(parsedPropertyCardToExtracted({})).toEqual({ type: FleetDocumentType.PROPERTY_CARD });
    });
  });
});
