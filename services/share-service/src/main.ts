import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'share-service' });

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
  const logger = createLogger('share-service');
  initDefaultMetrics('share-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('share-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('share-service'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('share-service')
    .setDescription(
      'Contactos de confianza (OTP, BR-I06), enlaces de seguimiento firmados y página familia · VEO',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.share.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.share.v1',
      protoPath: join(__dirname, '../proto/share.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50061',
      // TLS-capable por env (ADR-016): con GRPC_TLS_* → mTLS; sin ellos → insecure (dev). UN helper compartido.
      credentials: buildGrpcServerCredentials(),
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3011);
  await app.listen(port);
  logger.info(
    `share-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50061'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
