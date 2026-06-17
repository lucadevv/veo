import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs).
bootstrapOtel({ serviceName: 'public-bff' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { LoggingInterceptor, createLogger, initDefaultMetrics } from '@veo/observability';
import { AppModule } from './app.module';
import { PublicExceptionFilter } from './common/public-exception.filter';

async function bootstrap(): Promise<void> {
  const logger = createLogger('public-bff');
  initDefaultMetrics('public-bff');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  // El body por defecto de Nest/Express tope ~100KB; la verificación KYC envía frames JPEG en base64
  // (varios cientos de KB) → daba 413 PayloadTooLargeError. Subimos el límite JSON a 5MB (suficiente
  // para los frames de liveness; el resto de payloads del BFF son pequeños).
  app.useBodyParser('json', { limit: '5mb' });

  app.use(helmet());
  // CORS con credenciales: lista de orígenes por env ('*' permite cualquiera).
  const corsOrigins = (process.env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
  });

  // forbidNonWhitelisted: un campo extra en el body → 400 (fail-loud) en vez de descartarlo en silencio.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new PublicExceptionFilter(createLogger('public-bff')));
  app.useGlobalInterceptors(new LoggingInterceptor('public-bff'));
  // /api/v1 para la API; health y metrics quedan fuera del prefijo.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live', 'metrics'] });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('public-bff')
    .setDescription('BFF del pasajero · agrega identity, trip, dispatch, payment, panic, share, rating · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  logger.info(`public-bff escuchando en :${port}`);
}

bootstrap().catch((err) => {
  // Falla de arranque: log fatal y salida (logger del proceso, antes de levantar Nest).
  createLogger('public-bff').error({ err }, 'Bootstrap falló');
  process.exit(1);
});
