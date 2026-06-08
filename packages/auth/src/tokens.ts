/**
 * Tokens de inyección para wirear @veo/auth en cada app NestJS sin acoplar la librería a la config.
 * La app provee JwtService y el secreto interno; los guards los reciben por DI.
 */
export const JWT_SERVICE = Symbol('VEO_JWT_SERVICE');
export const INTERNAL_IDENTITY_SECRET = Symbol('VEO_INTERNAL_IDENTITY_SECRET');
