import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs).
bootstrapOtel({ serviceName: 'driver-bff' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { LoggingInterceptor, createLogger, initDefaultMetrics } from '@veo/observability';
import { AppModule } from './app.module';
import { PublicExceptionFilter } from './common/public-exception.filter';
import type { Env } from './config/env.schema';

function parseCors(origins: string): boolean | string[] {
  const trimmed = origins.trim();
  if (trimmed === '*' || trimmed === '') return true;
  return trimmed.split(',').map((o) => o.trim());
}

async function bootstrap(): Promise<void> {
  const logger = createLogger('driver-bff');
  initDefaultMetrics('driver-bff');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  // Body JSON hasta 5MB: el enroll biométrico manda la selfie en base64 (alineado con identity-service).
  // Sin esto, el default de Nest/Express (100kb) rechaza la foto con 413 antes de proxearla a identity.
  app.useBodyParser('json', { limit: '5mb' });

  app.use(helmet());
  app.enableCors({
    origin: parseCors(config.getOrThrow<string>('CORS_ORIGINS')),
    credentials: true,
  });
  // forbidNonWhitelisted: un campo extra en el body → 400 (fail-loud) en vez de descartarlo en silencio.
  // Convención del repo (espeja admin-bff/public-bff/trip-service). Endurece `extractedData` (Lote 0):
  // una clave arbitraria en el JSONB OCR se RECHAZA en el borde público, no solo se strippea.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new PublicExceptionFilter(createLogger('driver-bff')));
  app.useGlobalInterceptors(new LoggingInterceptor('driver-bff'));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('driver-bff')
    .setDescription(
      'BFF de la app del conductor · VEO (gRPC lecturas + REST interno comandos + Socket.IO)',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  logger.info({ port }, 'driver-bff escuchando');
}

bootstrap().catch((err) => {
  // No usamos console.log (regla FOUNDATION); el logger pino reporta el fallo de arranque.
  createLogger('driver-bff').error({ err }, 'fallo en el arranque de driver-bff');
  process.exit(1);
});
