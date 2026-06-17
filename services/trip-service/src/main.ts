import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'trip-service' });

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
  const logger = createLogger('trip-service');
  initDefaultMetrics('trip-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  // forbidNonWhitelisted: un campo extra en el body → 400 (fail-loud) en vez de descartarlo en silencio.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('trip-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('trip-service'));
  // health/metrics quedan fuera del prefijo para sondas de orquestador (k8s/docker).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('trip-service')
    .setDescription(
      'Ciclo de vida del viaje: máquina de estados (BR-T02), tarifa (BR-T05), modo niño (BR-T07) · VEO',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.trip.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.trip.v1',
      protoPath: join(__dirname, '../proto/trip.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50052',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  logger.info(
    `trip-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50052'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
