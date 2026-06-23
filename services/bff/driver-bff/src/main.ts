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
import { parseTrustedProxy } from '@veo/utils';
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

  // SEGURIDAD (rate-limit): el deploy es VPC (cliente → ALB → ingress-nginx → pod), todos los proxies
  // con IP privada. Con `trust proxy` apuntando a los rangos privados, Express resuelve `req.ip` = la
  // IP pública real del cliente (descarta los hops privados del XFF), un-spoofeable. El guard de
  // rate-limit lee `req.ip`, así que un atacante NO puede rotar un header de IP para evadir el límite.
  // Configurable vía TRUSTED_PROXY (default = rangos privados del VPC).
  app.set('trust proxy', parseTrustedProxy(config.getOrThrow<string>('TRUSTED_PROXY')));

  // Body JSON hasta 5MB: el enroll biométrico manda la selfie en base64 (alineado con identity-service).
  // Sin esto, el default de Nest/Express (100kb) rechaza la foto con 413 antes de proxearla a identity.
  app.useBodyParser('json', { limit: '5mb' });

  app.use(helmet());
  app.enableCors({
    origin: parseCors(config.getOrThrow<string>('CORS_ORIGINS')),
    credentials: true,
  });
  // driver-bff es CLIENT-FACING: debe ser TOLERANTE a campos extra del cliente, NO fail-loud.
  // La app RN consume schemas COMPARTIDOS del api-client que pueden traer campos que un DTO PUNTUAL
  // del BFF no espeja (ej. `otpRequest` manda `{phone, type}`, pero `RequestOtpDto` solo declara `phone`).
  // Con `whitelist: true` esos campos extra TOP-LEVEL se STRIPEAN (no 400) — el comportamiento seguro
  // original. Por eso acá NO va `forbidNonWhitelisted` (eso rompía el OTP con 400).
  // OJO: esto NO debilita la validación de `extractedData` (Lote 0): esa seguridad la da
  // `@ValidateNested` + `@Type` con las clases discriminadas (las claves ANIDADAS no-whitelisteadas
  // se siguen recortando vía whitelist+nested), no `forbidNonWhitelisted`.
  // A DIFERENCIA de los servicios INTERNOS (fleet): ahí `forbidNonWhitelisted` SÍ va (contrato estricto
  // entre servicios, sin cliente que mande campos de más).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
