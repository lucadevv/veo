/**
 * Política de REDACCIÓN PII a nivel de campo (server-side, RBAC).
 *
 * La UI NUNCA autoriza: el BFF decide qué campos sensibles ve cada actor según sus roles. El
 * route-gate (@Roles) ya recorta QUÉ endpoints alcanza un rol; esta capa recorta QUÉ CAMPOS ve
 * dentro de un endpoint que un rol sub-Compliance sí alcanza (p.ej. SUPPORT_L1 ve un viaje pero
 * NO la identidad del pasajero).
 *
 * Umbral de IDENTIDAD PERSONAL = Compliance+ (matriz aprobada, NO re-decidir acá).
 * NUNCA se inventa data: redactar = `null` (identidad/montos), enmascarar placa, o coarse-geo.
 */
import { AdminRole } from '@veo/shared-types';
import type { GeoPoint } from '@veo/api-client';

/**
 * Identidad personal (nombre pasajero/conductor, teléfono, DNI/licencia): Compliance+.
 * Conjuntos EXPLÍCITOS de roles permitidos — NADA de string literals, todo via AdminRole.
 */
const IDENTITY_ROLES: readonly AdminRole[] = [
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];

/** Montos (fareCents y derivados): solo finanzas (+admin). */
const AMOUNT_ROLES: readonly AdminRole[] = [AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN];

/** Placa del vehículo: dispatch operativo + compliance + admin (SUPPORT → enmascarada). */
const PLATE_ROLES: readonly AdminRole[] = [
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];

/** Geo EXACTA de viaje (origen/destino): dispatch + compliance + admin (SUPPORT → coarse ~100m). */
const EXACT_TRIP_GEO_ROLES: readonly AdminRole[] = [
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];

/** ¿Alguno de los roles del actor está en el conjunto permitido? */
function hasAny(roles: readonly AdminRole[], allowed: readonly AdminRole[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/** ¿El actor puede ver IDENTIDAD personal (nombre/teléfono/DNI) sin redactar? */
export function canSeeIdentity(roles: readonly AdminRole[]): boolean {
  return hasAny(roles, IDENTITY_ROLES);
}

/** ¿El actor puede ver MONTOS (fareCents, etc.) sin redactar? */
export function canSeeAmounts(roles: readonly AdminRole[]): boolean {
  return hasAny(roles, AMOUNT_ROLES);
}

/** ¿El actor puede ver la PLACA completa (sin enmascarar)? */
export function canSeePlate(roles: readonly AdminRole[]): boolean {
  return hasAny(roles, PLATE_ROLES);
}

/** ¿El actor puede ver la GEO EXACTA del viaje (sin coarse)? */
export function canSeeExactTripGeo(roles: readonly AdminRole[]): boolean {
  return hasAny(roles, EXACT_TRIP_GEO_ROLES);
}

/**
 * Enmascara la placa: `'•••' + últimos 3`. NUNCA inventa caracteres — si la placa es más corta
 * que 3, devuelve lo que haya tras el prefijo. `null` se preserva como `null` (no hay dato).
 */
export function maskPlate(plate: string | null): string | null {
  if (plate === null) return null;
  return '•••' + plate.slice(-3);
}

/**
 * Coarse-geo: redondea lat/lon a 3 decimales (~100m). Degrada la precisión sin inventar una
 * ubicación falsa. `null` se preserva como `null`.
 */
export function coarseGeo(geo: GeoPoint | null): GeoPoint | null {
  if (geo === null) return null;
  return { lat: round3(geo.lat), lon: round3(geo.lon) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
