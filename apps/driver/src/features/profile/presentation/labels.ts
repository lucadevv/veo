import type {TFunction} from 'i18next';

/**
 * Humaniza un valor de enum del backend como FALLBACK honesto cuando no hay traducción:
 * `DRIVER_LICENSE` → "Licencia de conducir" no lo sabemos, pero `DRIVER_LICENSE` → "Driver license"
 * es infinitamente mejor que mostrarle el enum CRUDO al conductor. Reemplaza `_` por espacio y capitaliza.
 */
function humanize(value: string): string {
  const lower = value.replace(/_/g, ' ').trim().toLowerCase();
  return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : '—';
}

/**
 * Traduce un valor de enum del backend (estado/tipo) a texto legible vía i18n con la clave
 * `${ns}.${value}`; si la clave no existe, cae a una forma humanizada (NUNCA muestra el enum crudo).
 * Es la fuente única para que el perfil no exponga "AVAILABLE/VERIFIED/CLEARED/DRIVER_LICENSE/PENDING".
 */
export function enumLabel(t: TFunction, ns: string, value: string): string {
  return t(`${ns}.${value}`, {defaultValue: humanize(value)});
}

/** Valores "buenos" (verde) de los estados del perfil. Evita comparar strings mágicos sueltos en la UI. */
export const KYC_VERIFIED = 'VERIFIED';
export const BACKGROUND_CHECK_CLEARED = 'CLEARED';
