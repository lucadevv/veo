/**
 * Filtro global del public-bff: CONFIGURACIÓN del BffExceptionsFilter canónico (@veo/rpc) —
 * la implementación del contrato error→HTTP vive UNA sola vez allá.
 * Parámetros propios de esta superficie PÚBLICA (FOUNDATION §3, sin filtrar internals):
 *  - `maskDownstream5xx`: los 5xx aguas abajo se aplastan a 502 UPSTREAM_UNAVAILABLE
 *    (reintentable); los <500 (p.ej. 422 GATEWAY_CAPABILITY_UNAVAILABLE) se propagan LIMPIOS.
 *  - `exposeInternalErrorMessage: false`: un Error genérico responde 500 'Error interno'
 *    sin filtrar el message interno.
 */
import { Catch } from '@nestjs/common';
import type { Logger } from '@veo/observability';
import { BffExceptionsFilter } from '@veo/rpc';

@Catch()
export class PublicExceptionFilter extends BffExceptionsFilter {
  constructor(logger?: Logger) {
    super(logger, { maskDownstream5xx: true, exposeInternalErrorMessage: false });
  }
}
