/**
 * LoggerModule (FOUNDATION §5): provee el logger pino con redacción de PII vía DI.
 * Importar en el AppModule de cada servicio: `LoggerModule.forRoot('trip-service')`.
 */
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { createLogger, type Logger } from './logger.js';

/** Token DI para inyectar el `Logger` pino del servicio. */
export const LOGGER = Symbol('VEO_LOGGER');

@Global()
@Module({})
export class LoggerModule {
  static forRoot(service: string, level?: string): DynamicModule {
    const logger: Logger = createLogger(service, level ?? process.env.LOG_LEVEL ?? 'info');
    return {
      module: LoggerModule,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    };
  }
}
