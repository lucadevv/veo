/**
 * Tokens de inyección para los clientes downstream de dispatch-service.
 * Hoy: el cliente REST interno a trip-service (lectura del catálogo efectivo del admin para el filtro
 * defensivo de clase operable del pool · seam catálogo↔operabilidad, ADR 013).
 */

/** Cliente REST interno firmado (HMAC, audiencia `service-rail`) hacia trip-service. */
export const TRIP_REST = Symbol('TRIP_REST');
