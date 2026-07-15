import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'media-service' });

import { NestFactory } from '@nestjs/core';
import { buildGrpcServerCredentials } from '@veo/rpc';
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
  const logger = createLogger('media-service');
  initDefaultMetrics('media-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('media-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('media-service'));
  // health/ready y metrics quedan fuera del prefijo (probes de infra: /health, /metrics).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('media-service')
    .setDescription('Grabación LiveKit self-hosted, acceso a video con doble auth, retención · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.media.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.media.v1',
      protoPath: join(__dirname, '../proto/media.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50057',
      // TLS-capable por env (ADR-016): con GRPC_TLS_* → mTLS; sin ellos → insecure (dev). UN helper compartido.
      credentials: buildGrpcServerCredentials(),
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3007);
  await app.listen(port);
  logger.info(
    `media-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50057'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
