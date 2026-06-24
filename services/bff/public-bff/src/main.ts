import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs).
bootstrapOtel({ serviceName: 'public-bff' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { LoggingInterceptor, createLogger, initDefaultMetrics } from '@veo/observability';
import { parseTrustedProxy } from '@veo/utils';
import { AppModule } from './app.module';
import { PublicExceptionFilter } from './common/public-exception.filter';
import type { Env } from './config/env.schema';

/** CORS: lista separada por comas; '*' (o vacío) permite cualquier origen (solo dev). */
function parseCors(origins: string): boolean | string[] {
  const list = origins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.includes('*') || list.length === 0 ? true : list;
}

async function bootstrap(): Promise<void> {
  const logger = createLogger('public-bff');
  initDefaultMetrics('public-bff');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // ConfigService validado (Zod): NO leer process.env crudo — saltearse la validación deja entrar
  // config inválida. Patrón de referencia: driver-bff/main.ts (config.getOrThrow). Conforma public a él.
  const config = app.get(ConfigService<Env, true>);

  // SEGURIDAD (rate-limit): con `trust proxy` apuntando a los rangos privados, Express resuelve
  // `req.ip` = la IP real del cliente (descarta los hops privados del XFF), un-spoofeable. El guard de
  // rate-limit lee `req.ip`, así que un atacante NO puede rotar un header de IP para evadir el límite.
  // TRUSTED_PROXY se valida en env.schema; trust-all queda RECHAZADO por parseTrustedProxy (fail-fast).
  // CONTENCIÓN DE RED: en el deploy VPS la contención la dan (a) la red interna de Docker Compose (los
  // BFFs NO publican puertos al host), (b) el firewall del host (default-deny), y (c) Cloudflare Tunnel
  // como único ingreso (cloudflared alcanza los BFFs por la red docker).
  // TODO(vps): revisar TRUSTED_PROXY para Cloudflare Tunnel — el cliente real llega en CF-Connecting-IP,
  // el peer es cloudflared en la red docker; ajustar trust-proxy a ese modelo.
  app.set('trust proxy', parseTrustedProxy(config.getOrThrow<string>('TRUSTED_PROXY')));

  // El body por defecto de Nest/Express tope ~100KB; la verificación KYC envía frames JPEG en base64
  // (varios cientos de KB) → daba 413 PayloadTooLargeError. Subimos el límite JSON a 5MB (suficiente
  // para los frames de liveness; el resto de payloads del BFF son pequeños).
  app.useBodyParser('json', { limit: '5mb' });

  app.use(helmet());
  app.enableCors({
    origin: parseCors(config.getOrThrow<string>('CORS_ORIGINS')),
    credentials: true,
  });

  // forbidNonWhitelisted: un campo extra en el body → 400 (fail-loud) en vez de descartarlo en silencio.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new PublicExceptionFilter(createLogger('public-bff')));
  app.useGlobalInterceptors(new LoggingInterceptor('public-bff'));
  // /api/v1 para la API; health y metrics quedan fuera del prefijo.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live', 'metrics'] });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('public-bff')
    .setDescription(
      'BFF del pasajero · agrega identity, trip, dispatch, payment, panic, share, rating · VEO',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  logger.info(`public-bff escuchando en :${port}`);
}

bootstrap().catch((err) => {
  // Falla de arranque: log fatal y salida (logger del proceso, antes de levantar Nest).
  createLogger('public-bff').error({ err }, 'Bootstrap falló');
  process.exit(1);
});
