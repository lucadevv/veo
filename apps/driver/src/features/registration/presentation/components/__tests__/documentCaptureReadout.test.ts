import { FleetDocumentType } from '@veo/shared-types';
import type { ParsedDocument } from '../../../../documents/domain';
import {
  isCriticalFieldMissing,
  readoutFromParsed,
  type CapturedReadout,
} from '../documentCaptureReadout';

/**
 * Pruebas de la lógica PURA del flujo "Capturado ✓" (Lote 1 · onboarding sin-formularios):
 *  - `readoutFromParsed`: el SOAT/licencia escaneados → `extractedData` mapeada al contrato + campos leídos.
 *  - `isCriticalFieldMissing`: GATING del campo crítico (número). Si el OCR no leyó el número de un tipo
 *    numerado, el flujo NO envía (pide reescaneo) — la regla que evita registrar un documento sin su dato
 *    crítico. Es la lógica que el sheet usa para decidir auto-submit vs. fallback honesto.
 */
describe('documentCaptureReadout · "Capturado ✓" + gating del campo crítico', () => {
  it('SOAT escaneado → readout con extractedData ExtractedSoatData (auto-proceder)', () => {
    const parsed: ParsedDocument = {
      kind: 'soat',
      policyNumber: 'POL-2026-0099',
      expiresAt: '2027-01-31',
    };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBe('POL-2026-0099');
    expect(readout.expiry).toBe('2027-01-31');
    expect(readout.extractedData).toEqual({
      type: FleetDocumentType.SOAT,
      policyNumber: 'POL-2026-0099',
      expiresAt: '2027-01-31',
    });
    // Campo crítico (número) presente → NO falta → el flujo auto-envía.
    expect(isCriticalFieldMissing(FleetDocumentType.SOAT, readout)).toBe(false);
  });

  it('licencia escaneada → readout con extractedData ExtractedLicenseA1Data (number→documentNumber)', () => {
    const parsed: ParsedDocument = {
      kind: 'license',
      number: 'Q12345678',
      category: 'A-I',
      expiresAt: '2028-06-30',
    };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBe('Q12345678');
    expect(readout.extractedData).toEqual({
      type: FleetDocumentType.LICENSE_A1,
      documentNumber: 'Q12345678',
      expiresAt: '2028-06-30',
      category: 'A-I',
    });
    expect(isCriticalFieldMissing(FleetDocumentType.LICENSE_A1, readout)).toBe(false);
  });

  it('campo crítico FALTANTE (SOAT sin número) → pide reescaneo, NO se auto-envía', () => {
    // El OCR leyó el vencimiento pero NO la póliza (campo crítico del SOAT).
    const parsed: ParsedDocument = { kind: 'soat', expiresAt: '2027-01-31' };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBeUndefined();
    // El gating detecta la ausencia del crítico → el sheet muestra "reescaneá", no envía.
    expect(isCriticalFieldMissing(FleetDocumentType.SOAT, readout)).toBe(true);
  });

  it('campo crítico FALTANTE (licencia sin número) → reescaneo', () => {
    const parsed: ParsedDocument = { kind: 'license', expiresAt: '2028-06-30' };
    expect(isCriticalFieldMissing(FleetDocumentType.LICENSE_A1, readoutFromParsed(parsed))).toBe(
      true,
    );
  });

  it('sin readout (escaneo sin texto OCR) → falta el crítico de un tipo numerado', () => {
    const noReadout: CapturedReadout | null = null;
    expect(isCriticalFieldMissing(FleetDocumentType.LICENSE_A1, noReadout)).toBe(true);
  });

  it('foto del vehículo (sin número) → NUNCA falta el crítico (no es un documento numerado)', () => {
    expect(isCriticalFieldMissing(FleetDocumentType.VEHICLE_PHOTO, null)).toBe(false);
  });

  // FIX B · gating de VENCIMIENTO: para los tipos que VENCEN (SOAT/licencia, `hasExpiry:true`), el
  // vencimiento es dato de validez legal. Si el OCR lee el número pero NO el vencimiento, el flujo NO debe
  // auto-enviar en silencio → es campo crítico faltante (pide reescaneo), igual que el número.
  it('FIX B · SOAT con número pero SIN vencimiento → crítico faltante (pide reescaneo, NO envía)', () => {
    const parsed: ParsedDocument = { kind: 'soat', policyNumber: 'POL-2026-0099' };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBe('POL-2026-0099');
    expect(readout.expiry).toBeUndefined();
    expect(isCriticalFieldMissing(FleetDocumentType.SOAT, readout)).toBe(true);
  });

  it('FIX B · licencia con número pero SIN vencimiento → crítico faltante (reescaneo)', () => {
    const parsed: ParsedDocument = { kind: 'license', number: 'Q12345678', category: 'A-I' };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBe('Q12345678');
    expect(readout.expiry).toBeUndefined();
    expect(isCriticalFieldMissing(FleetDocumentType.LICENSE_A1, readout)).toBe(true);
  });

  it('FIX B · SOAT COMPLETO (número + vencimiento) → NO falta el crítico (auto-envía)', () => {
    const parsed: ParsedDocument = {
      kind: 'soat',
      policyNumber: 'POL-2026-0099',
      expiresAt: '2027-01-31',
    };
    expect(isCriticalFieldMissing(FleetDocumentType.SOAT, readoutFromParsed(parsed))).toBe(false);
  });

  it('FIX B · tarjeta de propiedad (NO vence, hasExpiry:false) → con número y sin vencimiento, envía', () => {
    // La tarjeta es numerada pero NO vence: el vencimiento ausente NO la bloquea (gating contextual).
    const parsed: ParsedDocument = { kind: 'propertyCard', plate: 'ABC-123' };
    const readout = readoutFromParsed(parsed);
    expect(readout.number).toBe('ABC-123');
    expect(readout.expiry).toBeUndefined();
    expect(isCriticalFieldMissing(FleetDocumentType.PROPERTY_CARD, readout)).toBe(false);
  });
});
