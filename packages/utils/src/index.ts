/**
 * @veo/utils
 * Helpers compartidos: errores de dominio, ids (UUIDv7), dinero (PEN céntimos),
 * geo (H3), crypto (HMAC/audit chain), result, validación, aserciones de exhaustividad,
 * lock distribuido para jobs periódicos multi-réplica (cliente Redis inyectado).
 *
 * Convención: funciones puras + tipos. Sin estado, sin I/O propio (salvo node:crypto);
 * el lock distribuido opera sobre un cliente Redis INYECTADO (puerto mínimo, sin dependencia).
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
export * from './distributed-lock.js';
