/**
 * Endurecimiento de la validación del Lote 0 (data OCR persistida en JSONB) en el BORDE de fleet-service
 * (defensa en profundidad). Cubre:
 *   (a) `extractedData` con clave arbitraria / campo fuera de rango → RECHAZADO (forbidNonWhitelisted).
 *   (b) `extractedData` válido por tipo (unión discriminada) → ACEPTADO.
 *   (c) `ocrEngine` inválido (texto libre spoofeable) → RECHAZADO (enum cerrado).
 *   (d) sin OCR → sigue andando (backward-compat: las 3 columnas son opcionales).
 *
 * Se valida con `{ whitelist: true, forbidNonWhitelisted: true }` espejando el ValidationPipe global del
 * servicio (main.ts) — así el test refleja el comportamiento REAL del borde (clave extra → 400, no strip).
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { FleetDocumentType, OcrEngine } from '@veo/shared-types';
import { FleetOwnerType } from '../../generated/prisma';
import { CreateDocumentDto } from './document.dto';

const base = {
  ownerType: FleetOwnerType.DRIVER,
  ownerId: 'driver-profile-1',
  type: FleetDocumentType.DNI,
  documentNumber: 'X-123',
};

/** Espeja el ValidationPipe global (main.ts): whitelist + forbidNonWhitelisted. */
async function errorsFor(payload: Record<string, unknown>): Promise<ValidationError[]> {
  const dto = plainToInstance(CreateDocumentDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

function errorOn(errors: ValidationError[], property: string): ValidationError | undefined {
  return errors.find((e) => e.property === property);
}

describe('extractedData — validación FUERTE de la unión discriminada (Lote 0)', () => {
  it('(a) RECHAZA una clave arbitraria dentro de extractedData (no entra basura al JSONB)', async () => {
    const errors = await errorsFor({
      ...base,
      extractedData: { type: FleetDocumentType.DNI, fullName: 'Ana', hackKey: 'evil' },
    });
    const ed = errorOn(errors, 'extractedData');
    expect(ed).toBeDefined();
    // El error es del hijo `hackKey` (whitelistValidation: "property ... should not exist").
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

  it('(a) RECHAZA un birthdate con formato no YYYY-MM-DD', async () => {
    const errors = await errorsFor({
      ...base,
      extractedData: { type: FleetDocumentType.DNI, birthdate: '20/05/1990' },
    });
    expect(errorOn(errors, 'extractedData')).toBeDefined();
  });

  it('(b) ACEPTA extractedData DNI válido', async () => {
    const errors = await errorsFor({
      ...base,
      extractedData: {
        type: FleetDocumentType.DNI,
        fullName: 'Ana Pérez',
        documentNumber: '12345678',
        birthdate: '1990-05-21',
      },
    });
    expect(errorOn(errors, 'extractedData')).toBeUndefined();
  });

  it('(b) ACEPTA extractedData PROPERTY_CARD válido (otra rama de la unión)', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.PROPERTY_CARD,
      extractedData: {
        type: FleetDocumentType.PROPERTY_CARD,
        plate: 'ABC-123',
        make: 'Honda',
        model: 'CG 150',
        year: 2021,
        mtcCategory: 'L3',
      },
    });
    expect(errorOn(errors, 'extractedData')).toBeUndefined();
  });

  it('(b) ACEPTA energySource del enum cerrado en PROPERTY_CARD (combustible de la TIVe · ADR-017 §1.8)', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.PROPERTY_CARD,
      extractedData: { type: FleetDocumentType.PROPERTY_CARD, plate: 'ABC-123', energySource: 'GASOLINE_90' },
    });
    expect(errorOn(errors, 'extractedData')).toBeUndefined();
  });

  it('(a) RECHAZA un energySource fuera del enum (anti-spoof: GLP no está en los 4 tipos de ADR-017)', async () => {
    const errors = await errorsFor({
      ...base,
      type: FleetDocumentType.PROPERTY_CARD,
      extractedData: { type: FleetDocumentType.PROPERTY_CARD, energySource: 'GLP' },
    });
    const ed = errorOn(errors, 'extractedData');
    expect(ed).toBeDefined();
    const child = (ed?.children ?? []).find((c) => c.property === 'energySource');
    expect(child?.constraints).toHaveProperty('isEnum');
  });

  it('(c) RECHAZA un ocrEngine fuera del enum cerrado (anti-spoof de texto libre)', async () => {
    const errors = await errorsFor({ ...base, ocrEngine: 'totally-made-up-engine' });
    expect(errorOn(errors, 'ocrEngine')).toBeDefined();
  });

  it('(c) ACEPTA un ocrEngine del enum cerrado', async () => {
    const errors = await errorsFor({ ...base, ocrEngine: OcrEngine.ANDROID_MLKIT });
    expect(errorOn(errors, 'ocrEngine')).toBeUndefined();
  });

  it('(d) backward-compat: registrar SIN ningún campo de OCR sigue siendo válido', async () => {
    const errors = await errorsFor({ ...base });
    expect(errors.length).toBe(0);
  });
});
