import 'reflect-metadata';
import { bootstrapOtel } from '@veo/observability';

// OTel debe iniciar ANTES de crear la app (auto-instrumenta http/express/kafkajs/pg).
bootstrapOtel({ serviceName: 'notification-service' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import {
  AllExceptionsFilter,
  LoggingInterceptor,
  createLogger,
  initDefaultMetrics,
} from '@veo/observability';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = createLogger('notification-service');
  initDefaultMetrics('notification-service');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(createLogger('notification-service')));
  app.useGlobalInterceptors(new LoggingInterceptor('notification-service'));
  // health/metrics FUERA del prefijo /api/v1 (uniforme con el resto del stack: probes k8s y boot-stack
  // golpean /health, no /api/v1/health).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('notification-service')
    .setDescription(
      'Motor propio de notificaciones (push FCM/APNs, SMS SMPP, email SMTP, webhooks) · VEO',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 3008);
  await app.listen(port);
  logger.info(`notification-service escuchando en :${port}`);
}

bootstrap().catch((err) => {
  console.error('Bootstrap falló', err);
  process.exit(1);
});
