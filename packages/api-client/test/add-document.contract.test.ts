import { describe, expect, it } from 'vitest';
import { addDocumentRequest } from '../src/mobile.js';

/**
 * Test de contrato del registro de documento (`POST /drivers/me/documents`). Foco FIX D-2: `ocrAt` debe
 * VALIDAR formato ISO-8601 en el cliente para ESPEJAR la cota del backend (`@IsISO8601()`). Antes era
 * `z.string().optional()` (cualquier string pasaba), así que un timestamp basura llegaba al backend y solo
 * ahí se rechazaba. Ahora el contrato del cliente lo corta antes (fail-fast, simetría con el backend).
 */
describe('addDocumentRequest contract · ocrAt ISO-8601 (FIX D-2)', () => {
  const base = {
    type: 'SOAT',
    documentNumber: 'POL-2026-0099',
    images: [{ s3Key: 'docs/d1/soat.jpg', side: 'SINGLE' }],
  };

  it('acepta un ocrAt ISO-8601 válido (lo que produce `Date#toISOString()`)', () => {
    const parsed = addDocumentRequest.parse({ ...base, ocrAt: '2026-06-20T05:42:00.000Z' });
    expect(parsed.ocrAt).toBe('2026-06-20T05:42:00.000Z');
  });

  it('acepta un ocrAt con offset explícito (±hh:mm)', () => {
    const parsed = addDocumentRequest.parse({ ...base, ocrAt: '2026-06-20T00:42:00.000-05:00' });
    expect(parsed.ocrAt).toBe('2026-06-20T00:42:00.000-05:00');
  });

  it('RECHAZA un ocrAt que NO es ISO-8601 (string basura) — espeja @IsISO8601 del backend', () => {
    const result = addDocumentRequest.safeParse({ ...base, ocrAt: 'ayer a la tarde' });
    expect(result.success).toBe(false);
  });

  it('RECHAZA un ocrAt con solo fecha sin hora/offset (no datetime completo)', () => {
    const result = addDocumentRequest.safeParse({ ...base, ocrAt: '2026-06-20' });
    expect(result.success).toBe(false);
  });

  it('ocrAt es OPCIONAL: registrar SIN OCR sigue siendo válido (backward-compatible)', () => {
    const result = addDocumentRequest.safeParse(base);
    expect(result.success).toBe(true);
  });
});
