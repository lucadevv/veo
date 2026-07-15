/**
 * Clasificación de errores gRPC para consumidores Kafka que llaman gRPC DENTRO de un handler — hermana de
 * `isPermanentDataError` (@veo/events, lado Prisma). Un consumer que RELANZA ante un error gRPC PERMANENTE
 * (config/contrato: reintentar da SIEMPRE el mismo error) entra en crash-loop → head-of-line block de la
 * partición. El guard SALTA lo permanente (log & skip, el offset avanza) y RELANZA solo lo TRANSITORIO.
 *
 * Caso real (Lote 2b): el cliente gRPC de dispatch firmaba service-rail pero GetDriverByUser solo autorizaba
 * driver-rail → PERMISSION_DENIED determinista en cada re-entrega → la partición `fleet` se estancaba. La
 * causa raíz se arregló (se concedió el riel), pero un mismatch de audiencia/contrato futuro NO debe poder
 * volver a estancar una partición: por eso el guard es defensa en profundidad.
 */
import { status } from '@grpc/grpc-js';

/**
 * Códigos gRPC PERMANENTES (no-retriables): el request es estructuralmente inválido o no autorizado, así que
 * reintentarlo IDÉNTICO siempre falla igual. NO incluye los TRANSITORIOS (UNAVAILABLE/DEADLINE_EXCEEDED/
 * RESOURCE_EXHAUSTED/ABORTED/INTERNAL/UNKNOWN: red/carga/servidor caído → reintentar tiene sentido).
 */
const PERMANENT_GRPC_CODES: ReadonlySet<number> = new Set([
  status.INVALID_ARGUMENT, // 3  — payload mal formado (el contrato del request no se cumple)
  status.PERMISSION_DENIED, // 7  — riel/audiencia no autorizada (config de GRPC_METHOD_AUDIENCES)
  status.UNIMPLEMENTED, // 12 — método inexistente en el server (contrato roto)
  status.UNAUTHENTICATED, // 16 — identidad interna inválida / no firmada
]);

/**
 * ¿El error es un fallo gRPC PERMANENTE (no-retriable)? Detecta por el `code` (status de @grpc/grpc-js) que
 * el cliente propaga crudo. Un error SIN `code` numérico (no-gRPC: red cruda, lógica, etc.) → `false`: no se
 * asume permanente, así el caller RELANZA (defaultea a reintentar, el lado seguro para lo desconocido).
 */
export function isPermanentGrpcError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' && PERMANENT_GRPC_CODES.has(code);
}
