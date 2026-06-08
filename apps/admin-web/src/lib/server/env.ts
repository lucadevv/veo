/**
 * Acceso a variables de entorno SOLO de servidor (usado por Route Handlers y Server Components).
 * No se importa desde el cliente: vive bajo `lib/server/` y solo lee `process.env`.
 */

/** URL base del admin-bff (incluye /api/v1). Lanza si no está configurada. */
export function adminBffUrl(): string {
  const url = process.env.ADMIN_BFF_URL;
  if (!url) {
    throw new Error('ADMIN_BFF_URL no está configurada (ver .env.example).');
  }
  return url.replace(/\/$/, '');
}
