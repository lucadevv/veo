/**
 * Endurecimiento de la validación del Lote 0 (data OCR) en el BORDE PÚBLICO (driver-bff): es la primera
 * barrera antes de proxyar a fleet. Cubre:
 *   (a) `extractedData` con clave arbitraria / campo fuera de rango → RECHAZADO (forbidNonWhitelisted).
 *   (b) `extractedData` válido por tipo (unión discriminada por `type`) → ACEPTADO.
 *   (c) `ocrEngine` inválido (texto libre spoofeable) → RECHAZADO (enum cerrado).
 *   (d) sin OCR → sigue andando (backward-compat).
 *
 * Valida con `{ whitelist: true, forbidNonWhitelisted: true }` espejando el ValidationPipe global (main.ts).
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { FleetDocumentType, OcrEngine } from '@veo/shared-types';
import { AddDocumentDto } from './drivers.dto';

const base = {
  type: FleetDocumentType.DNI,
  documentNumber: 'X-123',
};

async function errorsFor(payload: Record<string, unknown>): Promise<ValidationError[]> {
  const dto = plainToInstance(AddDocumentDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

function errorOn(errors: ValidationError[], property: string): ValidationError | undefined {
  return errors.find((e) => e.property === property);
}

describe('extractedData — validación FUERTE en el borde público (Lote 0)', () => {
  it('(a) RECHAZA una clave arbitraria dentro de extractedData', async () => {
    const errors = await errorsFor({
      ...base,
      extractedData: { type: FleetDocumentType.DNI, fullName: 'Ana', hackKey: 'evil' },
    });
    const ed = errorOn(errors, 'extractedData');
    expect(ed).toBeDefined();
    const childKeys = (ed?.children ?? []).map((c) => c.property);
    expect(childKeys).toContain('hackKey');
  });

  it('(a) RECHAZA un campo fuera de rango (year > 2100 en PROPERTY_CARD)', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.PROPERTY_CARD,
      extractedData: { type: FleetDocumentType.PROPERTY_CARD, year: 3000 },
    });
    const ed = errorOn(errors, 'extractedData');
    expect(ed).toBeDefined();
    const yearChild = (ed?.children ?? []).find((c) => c.property === 'year');
    expect(yearChild?.constraints).toHaveProperty('max');
  });

  it('(b) ACEPTA extractedData LICENSE_A1 válido', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.LICENSE_A1,
      extractedData: {
        type: FleetDocumentType.LICENSE_A1,
        documentNumber: 'A1-9988',
        expiresAt: '2030-01-15',
      },
    });
    expect(errorOn(errors, 'extractedData')).toBeUndefined();
  });

  it('(b) ACEPTA extractedData SOAT válido', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.SOAT,
      extractedData: { type: FleetDocumentType.SOAT, policyNumber: 'POL-77', expiresAt: '2027-12-31' },
    });
    expect(errorOn(errors, 'extractedData')).toBeUndefined();
  });

  it('(c) RECHAZA un ocrEngine fuera del enum cerrado', async () => {
    const errors = await errorsFor({ ...base, ocrEngine: 'mlkit-android-spoof' });
    expect(errorOn(errors, 'ocrEngine')).toBeDefined();
  });

  it('(c) ACEPTA un ocrEngine del enum cerrado', async () => {
    const errors = await errorsFor({ ...base, ocrEngine: OcrEngine.IOS_VISIONKIT });
    expect(errorOn(errors, 'ocrEngine')).toBeUndefined();
  });

  it('(d) backward-compat: registrar SIN OCR sigue siendo válido', async () => {
    const errors = await errorsFor({ ...base });
    expect(errors.length).toBe(0);
  });
});
