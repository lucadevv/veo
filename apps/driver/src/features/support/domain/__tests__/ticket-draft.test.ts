import {
  isTicketDraftValid,
  toCreateTicketInput,
  validateTicketDraft,
  type TicketDraft,
} from '../value-objects/ticket-draft';

function makeDraft(overrides: Partial<TicketDraft> = {}): TicketDraft {
  return {
    category: 'TRIP',
    subject: 'Cobro incorrecto',
    body: 'Me cobraron de más en el último viaje y quiero una revisión.',
    ...overrides,
  };
}

describe('ticket-draft', () => {
  describe('validateTicketDraft', () => {
    it('un borrador completo es válido (sin errores)', () => {
      expect(validateTicketDraft(makeDraft())).toEqual({});
      expect(isTicketDraftValid(makeDraft())).toBe(true);
    });

    it('exige un asunto de longitud mínima (tras trim)', () => {
      expect(validateTicketDraft(makeDraft({ subject: 'ab' })).subject).toBe(
        'support.form.subjectTooShort',
      );
      expect(validateTicketDraft(makeDraft({ subject: '   ' })).subject).toBe(
        'support.form.subjectTooShort',
      );
    });

    it('rechaza un asunto demasiado largo', () => {
      expect(validateTicketDraft(makeDraft({ subject: 'x'.repeat(121) })).subject).toBe(
        'support.form.subjectTooLong',
      );
    });

    it('exige un cuerpo de longitud mínima', () => {
      expect(validateTicketDraft(makeDraft({ body: 'corto' })).body).toBe(
        'support.form.bodyTooShort',
      );
    });

    it('rechaza un cuerpo demasiado largo', () => {
      expect(validateTicketDraft(makeDraft({ body: 'x'.repeat(2001) })).body).toBe(
        'support.form.bodyTooLong',
      );
    });
  });

  describe('toCreateTicketInput', () => {
    it('recorta textos y omite tripId vacío', () => {
      const input = toCreateTicketInput(
        makeDraft({ subject: '  Asunto  ', body: '  Un cuerpo suficientemente largo.  ' }),
      );
      expect(input.subject).toBe('Asunto');
      expect(input.body).toBe('Un cuerpo suficientemente largo.');
      expect('tripId' in input).toBe(false);
    });

    it('incluye tripId cuando viene', () => {
      const input = toCreateTicketInput(makeDraft({ tripId: 'trip-123' }));
      expect(input.tripId).toBe('trip-123');
    });

    it('omite tripId si es solo espacios', () => {
      const input = toCreateTicketInput(makeDraft({ tripId: '   ' }));
      expect('tripId' in input).toBe(false);
    });

    it('lanza si el borrador es inválido', () => {
      expect(() => toCreateTicketInput(makeDraft({ subject: 'a' }))).toThrow();
    });
  });
});
