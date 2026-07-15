/**
 * Clave de caché COMPARTIDA del perfil del conductor.
 *
 * Vive en `domain` (no en el hook de presentation) porque es el contrato de caché que varias features
 * consumen sin acoplarse a la presentation de profile: mientras todos los hooks de React Query usen esta
 * MISMA key, el cache es único cross-feature (una sola request, datos coherentes entre `ProfileScreen`,
 * el saludo del Dashboard de `shift` y el nombre cacheado que lee `trips`). Es una constante pura —
 * `domain` NO importa React Query, solo publica el identificador de la query.
 */
export const PROFILE_QUERY_KEY = ['profile', 'me'] as const;
