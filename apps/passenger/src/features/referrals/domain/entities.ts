// Entidades de dominio de Referidos (Ola 2A). Contrato soberano en `@veo/api-client`.
export type {ReferralSummary} from '@veo/api-client';

/**
 * Longitud mínima razonable de un código de referido para canjear. El bff es la autoridad final
 * (formato/existencia/uso único); aquí solo evitamos pegarle a la red con entradas vacías.
 */
export const MIN_REFERRAL_CODE_LENGTH = 4;

/** Normaliza un código de referido para comparar/enviar: sin espacios y en MAYÚSCULAS. */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}
