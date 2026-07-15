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
/**
 * Audiencias de riel (`InternalAudience[]`) que un microservicio ACEPTA en la identidad interna firmada.
 * Cada servicio provee su lista (derivada de qué rieles lo invocan legítimamente); el InternalIdentityGuard
 * y los controllers gRPC la usan para rechazar (fail-closed) identidades de un riel no contemplado, aunque
 * el HMAC sea válido. Acota el radio de explosión del secreto único (FOUNDATION §14).
 */
export const INTERNAL_IDENTITY_ALLOWED_AUDIENCES = Symbol(
  'VEO_INTERNAL_IDENTITY_ALLOWED_AUDIENCES',
);
/**
 * Audiencia de riel (`InternalAudience`) con la que un EMISOR (BFF o servicio que hace llamadas de sistema)
 * FIRMA la identidad interna. Cada BFF provee la suya (public-bff → 'public-rail', etc.); las llamadas
 * service→service firman con 'service-rail'.
 */
export const INTERNAL_IDENTITY_AUDIENCE = Symbol('VEO_INTERNAL_IDENTITY_AUDIENCE');
