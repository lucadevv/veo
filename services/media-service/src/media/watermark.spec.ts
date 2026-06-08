import { describe, it, expect } from 'vitest';
import { buildWatermark } from './watermark';

describe('buildWatermark · watermark dinámico (BR-S02)', () => {
  const at = new Date('2026-05-28T23:30:00.000Z');

  it('incrusta el email del operador, el id de solicitud y el timestamp', () => {
    const wm = buildWatermark({ operatorEmail: 'ana@veo.pe', requestId: 'req-123', at });
    expect(wm).toContain('ana@veo.pe');
    expect(wm).toContain('req-123');
    expect(wm).toContain('2026-05-28T23:30:00.000Z');
    expect(wm).toBe('VEO · ana@veo.pe · req-123 · 2026-05-28T23:30:00.000Z');
  });

  it('es determinista para las mismas entradas', () => {
    const a = buildWatermark({ operatorEmail: 'op@veo.pe', requestId: 'r1', at });
    const b = buildWatermark({ operatorEmail: 'op@veo.pe', requestId: 'r1', at });
    expect(a).toBe(b);
  });

  it('cambia con el operador (trazabilidad por usuario)', () => {
    const a = buildWatermark({ operatorEmail: 'a@veo.pe', requestId: 'r1', at });
    const b = buildWatermark({ operatorEmail: 'b@veo.pe', requestId: 'r1', at });
    expect(a).not.toBe(b);
  });
});
