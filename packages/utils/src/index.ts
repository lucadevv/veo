/**
 * @veo/utils
 * Helpers compartidos: errores de dominio, ids (UUIDv7), dinero (PEN céntimos),
 * geo (H3), crypto (HMAC/audit chain), result, validación, aserciones de exhaustividad.
 *
 * Convención: funciones puras + tipos. Sin estado, sin I/O (salvo node:crypto).
 */
export * from './assert.js';
export * from './errors.js';
export * from './ids.js';
export * from './money.js';
export * from './geo.js';
export * from './crypto.js';
export * from './result.js';
export * from './validation.js';
export * from './env.js';
