import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'rating-service' });

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
  const logger = createLogger('rating-service');
  initDefaultMetrics('rating-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('rating-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('rating-service'));
  // /health, /health/ready y /metrics quedan fuera del prefijo (sondas de infra/Docker).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('rating-service')
    .setDescription('Calificaciones post-viaje, promedio rolling 30d, flags BR-D01/BR-I05 · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona del agregado (veo.rating.v1, lo usa dispatch).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.rating.v1',
      protoPath: join(__dirname, '../proto/rating.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50060',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3010);
  await app.listen(port);
  logger.info(`rating-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50060'})`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
