/**
 * @veo/database
 * Helpers Prisma compartidos: read/write split, outbox pattern, tombstone (derecho al olvido).
 * Cada servicio tiene su propio schema.prisma y cliente generado; estos helpers son genéricos.
 *
 * NOTA: el helper de testcontainers vive en `@veo/database/testing` (subpath aparte) para no
 * arrastrar testcontainers al runtime de producción.
 */
export * from './read-write.js';
export * from './outbox.js';
export * from './tombstone.js';
export * from './prisma-errors.js';
