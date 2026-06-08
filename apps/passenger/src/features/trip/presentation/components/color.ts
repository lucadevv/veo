/**
 * Aplica alfa a un color hex (#RGB / #RRGGBB) devolviendo `rgba(...)`. Local al flujo de viaje
 * porque el helper equivalente del ui-kit no es público (mismo patrón que `panic/.../color.ts` y
 * `auth/.../color.ts`). Se usa para las cards tintadas accent del diseño (control parental,
 * scrims). Si el formato no es hex reconocido, devuelve el color tal cual (degradación segura).
 */
export function hexAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  const captured = match?.[1];
  if (!captured) {
    return hex;
  }
  let value = captured;
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}
