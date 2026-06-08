/**
 * Normalización/validación de teléfonos móviles peruanos alineada con el contrato del bff
 * (`/^\+?51?9\d{8}$/` en identity-service, public-bff y `@veo/api-client`).
 *
 * El bff exige el prefijo de país 51, por lo que un número local de 9 dígitos (`9XXXXXXXX`) debe
 * normalizarse anteponiendo `51` antes de enviarlo (de lo contrario el bff devuelve 400).
 */

/** Regex exacto del bff (incluye el prefijo de país opcional con `+`). */
export const PERU_PHONE_PATTERN = /^\+?51?9\d{8}$/;

/**
 * Normaliza la entrada del usuario a un E.164 sin separadores apto para el bff:
 *  - elimina espacios, guiones y paréntesis,
 *  - si recibe un número local `9XXXXXXXX`, antepone `51`,
 *  - conserva el `+` inicial si venía.
 */
export function normalizePeruPhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  const withCountry = /^9\d{8}$/.test(digits) ? `51${digits}` : digits;
  return hasPlus ? `+${withCountry}` : withCountry;
}

/** Valida el teléfono ya normalizado contra el patrón del bff. */
export function isValidPeruPhone(raw: string): boolean {
  return PERU_PHONE_PATTERN.test(normalizePeruPhone(raw));
}
