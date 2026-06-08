/**
 * Normalización y validación del teléfono del conductor (Perú).
 * Mantiene una única razón para cambiar (SRP): la regla del número vive aquí, no en widgets/BLoCs.
 */

/** Número peruano normalizado: `+51` seguido de un móvil que empieza en 9 (8 dígitos restantes). */
const PERU_MOBILE = /^\+519\d{8}$/;

/**
 * Normaliza entradas comunes a formato `+519XXXXXXXX`.
 * Acepta: `987654321`, `51987654321`, `+51987654321` (con o sin espacios/guiones).
 */
export function normalizePeruPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+51')) {
    return digits;
  }
  if (digits.startsWith('51')) {
    return `+${digits}`;
  }
  if (digits.startsWith('+')) {
    return digits;
  }
  return `+51${digits}`;
}

/** true si el teléfono normalizado es un móvil peruano válido. */
export function isValidPeruPhone(raw: string): boolean {
  return PERU_MOBILE.test(normalizePeruPhone(raw));
}
