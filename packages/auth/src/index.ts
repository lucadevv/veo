/**
 * @veo/auth
 * JWT ES256 (jose), refresh con rotación+Redis, guards/decorators NestJS, RBAC, step-up TOTP,
 * propagación de identidad interna BFF→servicio.
 */
export * from './jwt.js';
export * from './refresh-store.js';
export * from './internal-identity.js';
export * from './ownership.js';
export * from './totp.js';
export * from './decorators.js';
export * from './tokens.js';
export * from './guards/jwt-auth.guard.js';
export * from './guards/internal-identity.guard.js';
export * from './guards/roles.guard.js';
export * from './guards/audience.guard.js';
export * from './guards/step-up-mfa.guard.js';
