/**
 * Tokens de inyección para los clientes downstream de fleet-service.
 * Hoy: el cliente REST interno a trip-service (lectura del catálogo efectivo del admin).
 */

/** Cliente REST interno firmado (HMAC, audiencia `service-rail`) hacia trip-service. */
export const TRIP_REST = Symbol('TRIP_REST');
