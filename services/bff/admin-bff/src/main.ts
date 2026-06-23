import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs).
bootstrapOtel({ serviceName: 'admin-bff' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { LoggingInterceptor, createLogger, initDefaultMetrics } from '@veo/observability';
import { parseTrustedProxy } from '@veo/utils';
import { BffExceptionsFilter } from '@veo/rpc';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const logger = createLogger('admin-bff');
  initDefaultMetrics('admin-bff');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // ConfigService validado (Zod): NO leer process.env crudo — saltearse la validación deja entrar
  // config inválida. Patrón de referencia: driver-bff/main.ts (config.getOrThrow). Conforma admin a él.
  const config = app.get(ConfigService<Env, true>);

  // SEGURIDAD (rate-limit): el deploy es VPC (cliente → ALB → ingress-nginx → pod), todos los proxies
  // con IP privada. Con `trust proxy` apuntando a los rangos privados, Express resuelve `req.ip` = la
  // IP pública real del cliente (descarta los hops privados del XFF), un-spoofeable. El guard de
  // rate-limit lee `req.ip`, así que un atacante NO puede rotar un header de IP para evadir el límite.
  // TRUSTED_PROXY se valida en env.schema; trust-all queda RECHAZADO por parseTrustedProxy (fail-fast).
  // CONTENCIÓN DE RED: la NetworkPolicy `infra/k8s/base/networkpolicies/east-west.yaml` ya restringe el
  // ingreso al pod SOLO desde ingress-nginx (allow-bff-ingress) — segunda capa sobre el rango de confianza.
  app.set('trust proxy', parseTrustedProxy(config.getOrThrow<string>('TRUSTED_PROXY')));

  app.use(helmet());
  app.enableCors({
    origin: config.getOrThrow<string>('ADMIN_WEB_ORIGIN'),
    credentials: true,
  });
  // forbidNonWhitelisted: un campo extra en el body → 400 (fail-loud) en vez de descartarlo en silencio.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Filter canónico de @veo/rpc (DownstreamError + DomainError/HttpException → modelo de error
  // público). Admin con defaults: conserva status/code del downstream (más detalle para operación).
  app.useGlobalFilters(new BffExceptionsFilter(createLogger('admin-bff')));
  app.useGlobalInterceptors(new LoggingInterceptor('admin-bff'));
  // health/metrics fuera del prefijo /api/v1 (sondas y scraping).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('admin-bff')
    .setDescription('BFF del panel admin · RBAC, MFA step-up, agregaciones, ClickHouse · VEO')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  logger.info(`admin-bff escuchando en :${port} (Socket.IO namespace /ops)`);
}

bootstrap().catch((err) => {
  // No usamos console.* (regla FOUNDATION); el logger pino reporta el fallo de arranque (incluye el
  // fail-fast de env: TRUSTED_PROXY trust-all, secreto de dev en prod, etc.).
  createLogger('admin-bff').error({ err }, 'fallo en el arranque de admin-bff');
  process.exit(1);
});
