import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'audit-service' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
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
import { parseTrustedProxy } from '@veo/utils';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const logger = createLogger('audit-service');
  initDefaultMetrics('audit-service');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  // SEGURIDAD (Ley 29733): el POST /audit síncrono registra la IP del actor en el log INMUTABLE
  // (hash-chain append-only). Esa IP DEBE ser la real, no un header inyectado. Con `trust proxy`
  // apuntando a los rangos privados, Express resuelve `req.ip` = la IP real del cliente (un-spoofeable),
  // y el controller lee SOLO `req.ip` (no `x-forwarded-for` crudo). TRUSTED_PROXY se valida en
  // env.schema; trust-all queda RECHAZADO por parseTrustedProxy (fail-fast). En el deploy VPS la
  // contención de red la dan: (a) la red interna de Docker Compose (los BFFs NO publican puertos al
  // host), (b) el firewall del host (default-deny), y (c) Cloudflare Tunnel como único ingreso
  // (cloudflared alcanza los BFFs por la red docker).
  // TODO(vps): revisar TRUSTED_PROXY para Cloudflare Tunnel — el cliente real llega en CF-Connecting-IP,
  // el peer es cloudflared en la red docker; ajustar trust-proxy a ese modelo.
  app.set('trust proxy', parseTrustedProxy(config.getOrThrow<string>('TRUSTED_PROXY')));

  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('audit-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('audit-service'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('audit-service')
    .setDescription(
      'Log de auditoría inmutable (append-only, hash chain, MinIO object-lock self-hosted) · VEO · Ley 29733',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

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
  logger.info(
    `audit-service escuchando en :${port} (gRPC en ${process.env.GRPC_URL ?? '0.0.0.0:50059'})`,
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
