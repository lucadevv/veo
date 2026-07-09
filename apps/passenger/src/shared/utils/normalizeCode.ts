/**
 * Normaliza un código alfanumérico ingresado por el usuario (cupón, referido) para compararlo/enviarlo:
 * sin espacios (internos ni en los extremos) y en MAYÚSCULAS. Único punto de verdad para promos y referidos.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}
