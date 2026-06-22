import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'booking-service' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import {
  AllExceptionsFilter,
  LoggingInterceptor,
  createLogger,
  initDefaultMetrics,
} from '@veo/observability';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const logger = createLogger('booking-service');
  initDefaultMetrics('booking-service');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('booking-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('booking-service'));
  // health/metrics quedan fuera del prefijo para sondas de orquestador (k8s/docker) y para el
  // readiness del BFF, que prueba el downstream en /health (sin prefijo). Mismo patrón que identity.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('booking-service')
    .setDescription('Marketplace de carpooling PROGRAMADO: PublishedTrip + Booking (ADR-014) · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  // Config VALIDADA/COACCIONADA por Zod (envSchema): el ConfigModule corre `validate: validateEnv`, así que
  // el valor que se usa para listen() es el que Zod parseó (PORT ya coaccionado a number, GRPC_URL con su
  // default) — NO se relee process.env crudo, que saltearía la validación. FOUNDATION §4.
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  const grpcUrl = config.get('GRPC_URL', { infer: true });

  // Servidor gRPC para lectura síncrona desde otros servicios (veo.booking.v1 · puerto 50054, ADR-014 §7.2).
  // Los métodos booking.GetPublishedTrip/GetBooking y su .proto son F2+: por ahora NO se conecta el
  // microservicio gRPC para no referenciar un proto inexistente. Cuando se agregue proto/booking.proto,
  // wirear con app.connectMicroservice({ transport: Transport.GRPC, options: { package: 'veo.booking.v1',
  // protoPath: join(__dirname, '../proto/booking.proto'), url: grpcUrl } }) + startAllMicroservices.
  await app.listen(port);
  logger.info(
    `booking-service escuchando en :${port} (gRPC :${grpcUrl} reservado para F2)`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
