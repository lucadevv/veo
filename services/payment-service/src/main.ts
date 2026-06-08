import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'payment-service' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  const logger = createLogger('payment-service');
  initDefaultMetrics('payment-service');

  // `rawBody: true` preserva el cuerpo crudo (Buffer en `req.rawBody`) para verificar la firma HMAC
  // del webhook de ProntoPaga: la firma se calcula sobre los bytes EXACTOS recibidos, no sobre el JSON
  // re-serializado (un re-serialize cambiaría el orden/espacios y rompería la firma).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // Límite de body (hardening DoS, auditoría L1). El webhook público POST /webhooks/prontopaga
  // parseaba JSON sin tope → un body gigante (p.ej. 50MB) podía agotar memoria/CPU baratamente.
  // 512kb cubre de sobra los payloads reales (webhook ProntoPaga, comandos de cobro). Nest 10:
  // con `rawBody: true`, `useBodyParser('json', …)` PRESERVA el rawBody (inyecta el `verify` hook
  // que captura `req.rawBody`) y reemplaza al parser por defecto sin límite — la firma HMAC del
  // webhook se sigue verificando sobre los bytes exactos. Mismo límite para urlencoded.
  app.useBodyParser('json', { limit: '512kb' });
  app.useBodyParser('urlencoded', { limit: '512kb', extended: true });

  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('payment-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('payment-service'));
  // /health, /health/ready y /metrics quedan fuera del prefijo (sondas de infra/Docker).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('payment-service')
    .setDescription('Cobros Yape/Plin/efectivo, comisión, payouts, reembolsos y conciliación · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.payment.v1).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.payment.v1',
      protoPath: join(__dirname, '../proto/payment.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50055',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3005);
  await app.listen(port);
  logger.info(`payment-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50055'})`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
