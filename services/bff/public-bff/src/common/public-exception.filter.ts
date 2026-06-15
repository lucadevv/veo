/**
 * Filtro global del public-bff: CONFIGURACIÓN del BffExceptionsFilter canónico (@veo/rpc) —
 * la implementación del contrato error→HTTP vive UNA sola vez allá.
 * Parámetros propios de esta superficie PÚBLICA (FOUNDATION §3, sin filtrar internals):
 *  - `maskDownstream5xx`: los 5xx aguas abajo se aplastan a 502 UPSTREAM_UNAVAILABLE
 *    (reintentable); los <500 (p.ej. 422 GATEWAY_CAPABILITY_UNAVAILABLE) se propagan LIMPIOS.
 *  - `exposeInternalErrorMessage: false`: un Error genérico responde 500 'Error interno'
 *    sin filtrar el message interno.
 *  - `exposeHttpExceptionDetails: true`: incluye el body de HttpException (los mensajes de validación
 *    de los DTOs, class-validator) como `details` en los 4xx. Son sobre la FORMA del request (no
 *    secretos), así la app puede mostrar el error REAL ("teléfono inválido") en vez de un genérico que
 *    el cliente mapea a "sin conexión". Mismo criterio que driver-bff. NO afecta el 500 (sigue genérico).
 */
import { Catch } from '@nestjs/common';
import type { Logger } from '@veo/observability';
import { BffExceptionsFilter } from '@veo/rpc';

@Catch()
export class PublicExceptionFilter extends BffExceptionsFilter {
  constructor(logger?: Logger) {
    super(logger, {
      maskDownstream5xx: true,
      exposeInternalErrorMessage: false,
      exposeHttpExceptionDetails: true,
    });
  }
}
