import type { CreateTicketInput, SupportCategory } from '../entities';

/** Límites de validación del borrador de ticket (alineados con un backend razonable). */
export const SUBJECT_MIN = 4;
export const SUBJECT_MAX = 120;
export const BODY_MIN = 10;
export const BODY_MAX = 2000;

/** Borrador editable del formulario "Reportar un problema". */
export interface TicketDraft {
  category: SupportCategory;
  subject: string;
  body: string;
  /** Viaje relacionado (p. ej. el viaje activo). Opcional. */
  tripId?: string;
}

/** Errores de validación por campo (claves i18n); ausencia de clave = campo válido. */
export interface TicketDraftErrors {
  subject?: string;
  body?: string;
}

/**
 * Valida un borrador de ticket de forma pura (sin tocar la red). Devuelve las claves i18n de error
 * por campo. El asunto y el cuerpo se exigen con longitudes mínimas para que el ticket sea accionable
 * por soporte; ambos se recortan (trim) antes de medir.
 */
export function validateTicketDraft(draft: TicketDraft): TicketDraftErrors {
  const errors: TicketDraftErrors = {};
  const subject = draft.subject.trim();
  const body = draft.body.trim();

  if (subject.length < SUBJECT_MIN) {
    errors.subject = 'support.form.subjectTooShort';
  } else if (subject.length > SUBJECT_MAX) {
    errors.subject = 'support.form.subjectTooLong';
  }

  if (body.length < BODY_MIN) {
    errors.body = 'support.form.bodyTooShort';
  } else if (body.length > BODY_MAX) {
    errors.body = 'support.form.bodyTooLong';
  }

  return errors;
}

/** `true` si el borrador no tiene errores (listo para enviar). */
export function isTicketDraftValid(draft: TicketDraft): boolean {
  return Object.keys(validateTicketDraft(draft)).length === 0;
}

/**
 * Normaliza un borrador válido al cuerpo de la petición `POST /support/tickets`: recorta textos y
 * omite `tripId` si viene vacío (el contrato lo declara opcional). Lanza si el borrador es inválido,
 * para que el llamador valide antes (el formulario bloquea el envío).
 */
export function toCreateTicketInput(draft: TicketDraft): CreateTicketInput {
  if (!isTicketDraftValid(draft)) {
    throw new Error('El ticket no es válido');
  }
  const tripId = draft.tripId?.trim();
  return {
    category: draft.category,
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    ...(tripId ? { tripId } : {}),
  };
}
