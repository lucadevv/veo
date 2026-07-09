/**
 * Claves de caché COMPARTIDAS del dominio de registro. Viven en `domain` (no en `presentation`) para
 * que otras features (turno, carpooling) puedan leer los MISMOS datos con cache coherente SIN importar
 * los hooks internos de `registration/presentation` (feature-isolation). Cada consumidor —propio o
 * ajeno— arma su `useQuery` fino sobre estas claves + el repositorio inyectado por DI.
 */

/** Clave de caché del listado de vehículos del conductor. */
export const REGISTRATION_VEHICLES_QUERY_KEY = ['registration', 'vehicles'] as const;

/** Clave de caché del vehículo ACTIVO del conductor (server-authoritative). */
export const ACTIVE_VEHICLE_QUERY_KEY = ['registration', 'active-vehicle'] as const;
