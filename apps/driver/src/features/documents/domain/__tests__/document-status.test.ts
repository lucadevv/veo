import {
  classifyByExpiry,
  documentStatusTone,
  isBlocking,
  needsAttention,
  statusPriority,
} from '../value-objects/document-status';

describe('document-status', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');

  describe('classifyByExpiry', () => {
    it('sin fecha o fecha inválida → en_revision', () => {
      expect(classifyByExpiry(null, now)).toBe('en_revision');
      expect(classifyByExpiry(undefined, now)).toBe('en_revision');
      expect(classifyByExpiry('no-es-fecha', now)).toBe('en_revision');
    });

    it('fecha ya pasada → vencido', () => {
      expect(classifyByExpiry('2026-05-29T12:00:00.000Z', now)).toBe('vencido');
      expect(classifyByExpiry('2020-01-01T00:00:00.000Z', now)).toBe('vencido');
    });

    it('dentro de la ventana de aviso (≤30 días) → por_vencer', () => {
      // Mismo día (0 días restantes) cuenta como por vencer.
      expect(classifyByExpiry('2026-05-30T20:00:00.000Z', now)).toBe('por_vencer');
      expect(classifyByExpiry('2026-06-15T12:00:00.000Z', now)).toBe('por_vencer');
      // Justo en el límite de 30 días.
      expect(classifyByExpiry('2026-06-29T12:00:00.000Z', now)).toBe('por_vencer');
    });

    it('más allá de la ventana de aviso → vigente', () => {
      expect(classifyByExpiry('2026-07-15T12:00:00.000Z', now)).toBe('vigente');
      expect(classifyByExpiry('2027-01-01T00:00:00.000Z', now)).toBe('vigente');
    });

    it('respeta una ventana de aviso personalizada', () => {
      expect(classifyByExpiry('2026-06-05T12:00:00.000Z', now, 3)).toBe('vigente');
      expect(classifyByExpiry('2026-06-02T12:00:00.000Z', now, 3)).toBe('por_vencer');
    });
  });

  describe('needsAttention / isBlocking', () => {
    it('requieren atención: vencido, por_vencer y rechazado', () => {
      expect(needsAttention('vencido')).toBe(true);
      expect(needsAttention('por_vencer')).toBe(true);
      expect(needsAttention('rechazado')).toBe(true);
      expect(needsAttention('vigente')).toBe(false);
      expect(needsAttention('en_revision')).toBe(false);
    });

    it('bloquean operar solo vencido y rechazado', () => {
      expect(isBlocking('vencido')).toBe(true);
      expect(isBlocking('rechazado')).toBe(true);
      expect(isBlocking('por_vencer')).toBe(false);
      expect(isBlocking('vigente')).toBe(false);
      expect(isBlocking('en_revision')).toBe(false);
    });
  });

  describe('documentStatusTone', () => {
    it('mapea cada estado a su tono de chip', () => {
      expect(documentStatusTone('vigente')).toBe('success');
      expect(documentStatusTone('por_vencer')).toBe('warn');
      expect(documentStatusTone('vencido')).toBe('danger');
      expect(documentStatusTone('rechazado')).toBe('danger');
      expect(documentStatusTone('en_revision')).toBe('neutral');
    });
  });

  describe('statusPriority', () => {
    it('ordena de más urgente a menos urgente', () => {
      const order = (['vigente', 'en_revision', 'por_vencer', 'rechazado', 'vencido'] as const)
        .slice()
        .sort((a, b) => statusPriority(a) - statusPriority(b));
      expect(order).toEqual(['vencido', 'rechazado', 'por_vencer', 'en_revision', 'vigente']);
    });
  });
});
