/**
 * Aplica alpha a un color hex de 6 dígitos (#RRGGBB -> #RRGGBBAA).
 * Si no es hex de 6 dígitos (p.ej. rgba/transparent), lo devuelve igual.
 */
export function hexAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${a}`.toUpperCase();
}
