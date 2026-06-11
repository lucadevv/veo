/**
 * Filtro global del driver-bff: CONFIGURACIÓN del BffExceptionsFilter canónico (@veo/rpc) —
 * la implementación del contrato error→HTTP vive UNA sola vez allá.
 * Parámetros propios de esta superficie:
 *  - SIN aplastar 5xx downstream: la app del conductor recibe status/code/message del servicio
 *    de origen (igual que admin; el aplastado a 502 es solo de public-bff).
 *  - `exposeHttpExceptionDetails`: el body de HttpException (p.ej. los mensajes del
 *    ValidationPipe) viaja como `details` — la app del conductor los lee.
 */
import { Catch } from '@nestjs/common';
import type { Logger } from '@veo/observability';
import { BffExceptionsFilter } from '@veo/rpc';

@Catch()
export class PublicExceptionFilter extends BffExceptionsFilter {
  constructor(logger?: Logger) {
    super(logger, { exposeHttpExceptionDetails: true });
  }
}
