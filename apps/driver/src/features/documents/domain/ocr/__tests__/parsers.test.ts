import { FleetDocumentType } from '@veo/shared-types';
import { parseDni } from '../parse-dni';
import { parseLicense } from '../parse-license';
import { parseSoat } from '../parse-soat';
import { parsePropertyCard } from '../parse-property-card';
import { parseDocument, isParsableDocumentType } from '../parse-document';
import { normalizePeruvianDate } from '../ocr-date';
import { normalizeLicenseCategory } from '../license-category';

/**
 * Tests de los parsers PUROS de OCR con líneas REALISTAS de documentos peruanos (DNI, licencia, SOAT,
 * tarjeta de propiedad). Lo más valioso: (1) que extraigan los campos correctos de un documento legible
 * y (2) que ante texto BASURA no inventen nada (devuelvan vacío). Las líneas imitan lo que Vision/MLKit
 * reconoce on-device: etiquetas + valores, mayúsculas inconsistentes, fechas DD/MM/AAAA.
 */

describe('normalizePeruvianDate · normaliza fechas peruanas a YYYY-MM-DD', () => {
  it('numérica DD/MM/AAAA', () => {
    expect(normalizePeruvianDate('Vence 31/12/2027')).toBe('2027-12-31');
  });
  it('numérica con guiones y puntos', () => {
    expect(normalizePeruvianDate('05-03-2026')).toBe('2026-03-05');
    expect(normalizePeruvianDate('05.03.2026')).toBe('2026-03-05');
  });
  it('textual con mes en letras (abreviado y completo)', () => {
    expect(normalizePeruvianDate('12 ENE 2027')).toBe('2027-01-12');
    expect(normalizePeruvianDate('12 de enero de 2027')).toBe('2027-01-12');
  });
  it('rechaza fechas imposibles (31/02) → null (no inventa)', () => {
    expect(normalizePeruvianDate('31/02/2026')).toBeNull();
  });
  it('texto sin fecha → null', () => {
    expect(normalizePeruvianDate('LICENCIA DE CONDUCIR')).toBeNull();
  });
});

describe('normalizeLicenseCategory · mapea a la unión tipada', () => {
  it('reconoce variantes de A-IIb', () => {
    expect(normalizeLicenseCategory('A-IIb')).toBe('A-IIb');
    expect(normalizeLicenseCategory('A IIB')).toBe('A-IIb');
    expect(normalizeLicenseCategory('AIIB')).toBe('A-IIb');
  });
  it('reconoce A-I y A-IIIa', () => {
    expect(normalizeLicenseCategory('Categoría A-I')).toBe('A-I');
    expect(normalizeLicenseCategory('A-IIIa')).toBe('A-IIIa');
  });
  it('texto sin categoría → null', () => {
    expect(normalizeLicenseCategory('NINGUNA CLASE AQUI XYZ')).toBeNull();
  });
});

describe('parseDni · DNI peruano', () => {
  it('extrae número (8 díg), nombre y fecha de nacimiento', () => {
    const lines = [
      'REPÚBLICA DEL PERÚ',
      'REGISTRO NACIONAL DE IDENTIFICACIÓN',
      'DNI 45678912',
      'Apellidos: QUISPE MAMANI',
      'Pre Nombres: JUAN CARLOS',
      'Fecha de Nacimiento 23/08/1990',
    ];
    expect(parseDni(lines)).toEqual({
      documentNumber: '45678912',
      fullName: 'QUISPE MAMANI JUAN CARLOS',
      birthDate: '1990-08-23',
    });
  });

  it('toma el único 8-dígitos cuando no hay etiqueta DNI explícita', () => {
    const lines = ['REPUBLICA DEL PERU', '12349876', 'JUAN PEREZ'];
    expect(parseDni(lines).documentNumber).toBe('12349876');
  });

  it('NO adivina el DNI si hay varios 8-dígitos ambiguos sin etiqueta', () => {
    const lines = ['12349876', '88887777', 'sin etiqueta'];
    expect(parseDni(lines).documentNumber).toBeUndefined();
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseDni(['xxxx', 'yyyy', '12'])).toEqual({});
  });
});

describe('parseLicense · licencia de conducir peruana', () => {
  it('extrae número, categoría y vencimiento (revalidación)', () => {
    const lines = [
      'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
      'LICENCIA DE CONDUCIR',
      'N° Licencia Q12345678',
      'Categoría: A-IIb',
      'Fecha de Vencimiento 15/06/2028',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'Q12345678',
      category: 'A-IIb',
      expiresAt: '2028-06-15',
    });
  });

  it('ignora la fecha de EXPEDICIÓN y toma la de vencimiento', () => {
    const lines = [
      'Categoría A-I',
      'Fecha de Expedición 15/06/2024',
      'Revalidación 15/06/2029',
      'Q98765432',
    ];
    const parsed = parseLicense(lines);
    expect(parsed.expiresAt).toBe('2029-06-15');
    expect(parsed.category).toBe('A-I');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseLicense(['hola', 'mundo'])).toEqual({});
  });
});

describe('parseSoat · SOAT', () => {
  it('extrae número de póliza y vencimiento (fin de vigencia del rango)', () => {
    const lines = [
      'SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO',
      'N° de Póliza: SOAT-2026-0099123',
      'Vigencia Desde 01/01/2026 Hasta 31/12/2026',
      'Placa ABC-123',
    ];
    expect(parseSoat(lines)).toEqual({
      policyNumber: 'SOAT-2026-0099123',
      expiresAt: '2026-12-31',
    });
  });

  it('vencimiento en línea "Vence" separada', () => {
    const lines = ['Póliza: P-556677', 'Vence: 30/09/2027'];
    expect(parseSoat(lines)).toEqual({ policyNumber: 'P-556677', expiresAt: '2027-09-30' });
  });

  it('NO adivina el número de póliza sin etiqueta (omite)', () => {
    const lines = ['SEGURO', 'Hasta 31/12/2026'];
    const parsed = parseSoat(lines);
    expect(parsed.policyNumber).toBeUndefined();
    expect(parsed.expiresAt).toBe('2026-12-31');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseSoat(['xx', 'yy'])).toEqual({});
  });
});

describe('parsePropertyCard · tarjeta de propiedad', () => {
  it('extrae placa (normaliza con guion) y propietario', () => {
    const lines = [
      'SUNARP - TARJETA DE IDENTIFICACIÓN VEHICULAR',
      'Placa: ABC123',
      'Propietario: MARÍA LÓPEZ TORRES',
    ];
    expect(parsePropertyCard(lines)).toEqual({
      plate: 'ABC-123',
      owner: 'MARÍA LÓPEZ TORRES',
    });
  });

  it('reconoce la placa sin etiqueta si es la única del documento', () => {
    const lines = ['TARJETA DE PROPIEDAD', 'XYZ-789'];
    expect(parsePropertyCard(lines).plate).toBe('XYZ-789');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parsePropertyCard(['nada', 'aqui'])).toEqual({});
  });
});

describe('parseDocument · dispatcher tipado por FleetDocumentType', () => {
  it('LICENSE_A1 → parser de licencia (kind=license)', () => {
    const result = parseDocument(FleetDocumentType.LICENSE_A1, [
      'N° Licencia Q12345678',
      'Categoría A-IIb',
      'Vencimiento 15/06/2028',
    ]);
    expect(result).toEqual({
      kind: 'license',
      number: 'Q12345678',
      category: 'A-IIb',
      expiresAt: '2028-06-15',
    });
  });

  it('SOAT → parser de SOAT (kind=soat)', () => {
    const result = parseDocument(FleetDocumentType.SOAT, [
      'Póliza: P-001',
      'Hasta 31/12/2027',
    ]);
    expect(result).toEqual({ kind: 'soat', policyNumber: 'P-001', expiresAt: '2027-12-31' });
  });

  it('PROPERTY_CARD → parser de tarjeta (kind=propertyCard)', () => {
    const result = parseDocument(FleetDocumentType.PROPERTY_CARD, ['Placa ABC-123']);
    expect(result).toEqual({ kind: 'propertyCard', plate: 'ABC-123' });
  });

  it('documento ilegible → solo el kind (degradación honesta, sin campos)', () => {
    expect(parseDocument(FleetDocumentType.SOAT, ['basura'])).toEqual({ kind: 'soat' });
  });

  it('isParsableDocumentType: VEHICLE_PHOTO no es parseable; los demás sí', () => {
    expect(isParsableDocumentType(FleetDocumentType.VEHICLE_PHOTO)).toBe(false);
    expect(isParsableDocumentType(FleetDocumentType.LICENSE_A1)).toBe(true);
    expect(isParsableDocumentType(FleetDocumentType.SOAT)).toBe(true);
    expect(isParsableDocumentType(FleetDocumentType.PROPERTY_CARD)).toBe(true);
  });
});
