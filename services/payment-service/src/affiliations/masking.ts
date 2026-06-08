/**
 * Enmascarado de PII (Ley 29733): NUNCA guardamos ni logueamos el teléfono/documento completo en
 * contextos de UI/auditoría. Dejamos visible lo mínimo para que el usuario reconozca su dato.
 * Helpers PUROS (testeables).
 */

/** Enmascara un teléfono: deja los últimos 4 dígitos. "999881234" → "*****1234". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

/** Enmascara un documento: deja los últimos 2 caracteres. "12345678" → "******78". */
export function maskDocument(doc: string): string {
  const trimmed = doc.trim();
  if (trimmed.length <= 2) return '*'.repeat(trimmed.length);
  return '*'.repeat(trimmed.length - 2) + trimmed.slice(-2);
}
