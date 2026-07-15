import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'identity-service' });

import { NestFactory } from '@nestjs/core';
import { buildGrpcServerCredentials } from '@veo/rpc';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  const logger = createLogger('identity-service');
  initDefaultMetrics('identity-service');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // La verificación KYC del pasajero recibe frames JPEG en base64 (cientos de KB) reenviados por el
  // BFF; el tope por defecto (~100KB) los rechazaba con 413 → el BFF devolvía 502. Subimos a 5MB.
  app.useBodyParser('json', { limit: '5mb' });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('identity-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('identity-service'));
  // health/metrics quedan fuera del prefijo para sondas de orquestador (k8s/docker) y para el
  // readiness del BFF, que prueba el downstream en /health (sin prefijo). Mismo patrón que trip-service.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('identity-service')
    .setDescription('Auth (OTP+JWT), KYC, orquestación biométrica · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.identity.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.identity.v1',
      protoPath: join(__dirname, '../proto/identity.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50051',
      // TLS-capable por env (ADR-016): con GRPC_TLS_* → mTLS; sin ellos → insecure (dev). UN helper compartido.
      credentials: buildGrpcServerCredentials(),
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.info(
    `identity-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50051'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
