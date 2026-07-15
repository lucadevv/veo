/**
 * Claves de caché (React Query) del dominio de Perfil. Viven en `domain` para que features ajenas
 * (p.ej. el flujo de completar perfil en Auth) siembren/lean la MISMA clave sin importar la
 * `presentation` de Profile: la caché del perfil real queda caliente y coherente entre features.
 */

/**
 * Clave de caché del perfil real del pasajero (`GET /users/me`), AISLADA por `userId`.
 *
 * Incluir el `userId` evita una ventana de staleness entre cuentas: si un usuario cierra sesión y
 * otro entra (o se rehidrata otra sesión), su perfil cacheado NO se confunde con el del usuario
 * anterior. Las invalidaciones amplias (`['profile']`) siguen casando por prefijo.
 */
export function profileQueryKey(userId: string | null) {
  return ['profile', 'me', userId] as const;
}
