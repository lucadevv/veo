import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'dispatch-service' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'node:path';
import helmet from 'helmet';
import {
  AllExceptionsFilter,
  LoggingInterceptor,
  createLogger,
  initDefaultMetrics,
} from '@veo/observability';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = createLogger('dispatch-service');
  initDefaultMetrics('dispatch-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('dispatch-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('dispatch-service'));
  // El negocio cuelga de /api/v1; health y métricas quedan fuera del prefijo versionado
  // (probes de k8s y scrape de Prometheus en rutas estables /health y /metrics).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('dispatch-service')
    .setDescription('Matching geoespacial H3, scoring (BR-T06), surge y prioridad de pánico · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.dispatch.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.dispatch.v1',
      protoPath: join(__dirname, '../proto/dispatch.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50053',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3003);
  await app.listen(port);
  logger.info(
    `dispatch-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50053'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
