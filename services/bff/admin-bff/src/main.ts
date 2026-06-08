import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs).
bootstrapOtel({ serviceName: 'admin-bff' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { LoggingInterceptor, createLogger, initDefaultMetrics } from '@veo/observability';
import { AppModule } from './app.module';
import { BffExceptionsFilter } from './common/bff-exception.filter';

async function bootstrap(): Promise<void> {
  const logger = createLogger('admin-bff');
  initDefaultMetrics('admin-bff');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  app.enableCors({ origin: process.env.ADMIN_WEB_ORIGIN ?? 'http://localhost:5000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Mapea DownstreamError (de @veo/rpc) + DomainError/HttpException al modelo de error público.
  app.useGlobalFilters(new BffExceptionsFilter(createLogger('admin-bff')));
  app.useGlobalInterceptors(new LoggingInterceptor('admin-bff'));
  // health/metrics fuera del prefijo /api/v1 (sondas y scraping).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('admin-bff')
    .setDescription('BFF del panel admin · RBAC, MFA step-up, agregaciones, ClickHouse · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 4003);
  await app.listen(port);
  logger.info(`admin-bff escuchando en :${port} (Socket.IO namespace /ops)`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
