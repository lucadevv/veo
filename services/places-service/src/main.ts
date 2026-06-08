import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/pg).
bootstrapOtel({ serviceName: 'places-service' });

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
  const logger = createLogger('places-service');
  initDefaultMetrics('places-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('places-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('places-service'));
  // /health, /health/ready y /metrics quedan fuera del prefijo (sondas de infra/Docker).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('places-service')
    .setDescription('Lugares guardados del pasajero (Casa/Trabajo/favoritos) · CRUD gRPC para el BFF · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC: CRUD síncrono consumido por el public-bff (veo.places.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.places.v1',
      protoPath: join(__dirname, '../proto/places.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50063',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3013);
  await app.listen(port);
  logger.info(`places-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50063'})`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
