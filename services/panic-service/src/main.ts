import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'panic-service' });

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
  const logger = createLogger('panic-service');
  initDefaultMetrics('panic-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('panic-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('panic-service'));
  // Health y métricas quedan fuera del prefijo versionado para que las probes usen /health.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('panic-service')
    .setDescription(
      'Botón de pánico: idempotencia (BR-S04), publicación confiable (BR-S05), evidencia S3 Object Lock · VEO',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.panic.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.panic.v1',
      protoPath: join(__dirname, '../proto/panic.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50056',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3006);
  await app.listen(port);
  logger.info(
    `panic-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50056'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
