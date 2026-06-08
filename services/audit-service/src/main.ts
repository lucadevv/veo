import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'audit-service' });

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
  const logger = createLogger('audit-service');
  initDefaultMetrics('audit-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('audit-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('audit-service'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('audit-service')
    .setDescription('Log de auditoría inmutable (append-only, hash chain, S3 Object Lock) · VEO · Ley 29733')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  // Servidor gRPC (veo.audit.v1) para registro/verificación síncrona desde otros servicios.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'veo.audit.v1',
      protoPath: join(__dirname, '../proto/audit.proto'),
      url: process.env.GRPC_URL ?? '0.0.0.0:50059',
    },
  });
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3009);
  await app.listen(port);
  logger.info(`audit-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50059'})`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
