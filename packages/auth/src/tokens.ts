/**
 * Tokens de inyección para wirear @veo/auth en cada app NestJS sin acoplar la librería a la config.
 * La app provee JwtService y el secreto interno; los guards los reciben por DI.
 */
export const JWT_SERVICE = Symbol('VEO_JWT_SERVICE');
export const INTERNAL_IDENTITY_SECRET = Symbol('VEO_INTERNAL_IDENTITY_SECRET');
/**
 * Tipo de sujeto (passenger/driver/admin) que un BFF acepta en el access token. OPCIONAL: si la app lo
 * provee, el JwtAuthGuard rechaza tokens de otro `typ` (defensa en profundidad — los 3 BFFs comparten
 * issuer/audience/clave, así que sin esto un token de pasajero llega al admin-bff y solo lo frena el RBAC).
 */
export const EXPECTED_SUBJECT_TYPE = Symbol('VEO_EXPECTED_SUBJECT_TYPE');
