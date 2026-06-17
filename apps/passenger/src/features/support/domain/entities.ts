// Entidades de dominio de Soporte / Centro de Ayuda (contrato soberano en @veo/api-client).
export type {
  CreateTicketRequest,
  SupportCategory,
  SupportStatus,
  SupportTicket,
} from '@veo/api-client';

import type {SupportCategory} from '@veo/api-client';

/** Categorías de ticket en el orden que se muestran al pasajero en el selector. */
export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  'TRIP',
  'PAYMENT',
  'ACCOUNT',
  'SAFETY',
  'DRIVER',
  'OTHER',
] as const;

/** Longitud mínima del asunto tras recortar espacios. */
export const MIN_SUBJECT_LENGTH = 4;
/** Longitud máxima del asunto (el BFF también la valida). */
export const MAX_SUBJECT_LENGTH = 120;
/** Longitud mínima del mensaje tras recortar espacios. */
export const MIN_BODY_LENGTH = 10;
/** Longitud máxima del mensaje. */
export const MAX_BODY_LENGTH = 2000;
