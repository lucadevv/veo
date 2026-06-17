import { describe, it, expect } from 'vitest';
import { pino } from 'pino';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PII_REDACT_PATHS, createLogger } from './logger.js';
import { statusFromError } from './logging.interceptor.js';
import { metricsRegistry, httpRequestDuration } from './metrics.js';
import { HealthController } from './health.js';
import { AllExceptionsFilter } from './exception-filter.js';
import { NotFoundError } from '@veo/utils';

describe('logger · redacción PII', () => {
  it('censura phone/email/token, incluso anidados', () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: PII_REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (s: string) => void lines.push(s) },
    );
    log.info({ phone: '999888777', email: 'lucia@veo.pe', user: { phone: '111' }, token: 'abc' }, 'evento');
    const out = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(out.phone).toBe('[REDACTED]');
    expect(out.email).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect((out.user as Record<string, unknown>).phone).toBe('[REDACTED]');
  });
  it('createLogger devuelve un logger usable', () => {
    expect(typeof createLogger('test', 'silent').info).toBe('function');
  });
});

describe('métricas', () => {
  it('expone http_request_duration_seconds en el registry', async () => {
    httpRequestDuration.observe({ method: 'GET', route: '/trips', status: '200' }, 0.12);
    const text = await metricsRegistry.metrics();
    expect(text).toContain('http_request_duration_seconds');
  });
});

describe('HealthController', () => {
  it('liveness siempre ok', () => {
    expect(new HealthController([]).liveness()).toEqual({ status: 'ok' });
  });
  it('readiness pasa si todos los checks pasan', async () => {
    const c = new HealthController([{ name: 'db', check: async () => true }]);
    await expect(c.readiness()).resolves.toMatchObject({ status: 'ready', checks: { db: true } });
  });
  it('readiness lanza 503 si un check falla', async () => {
    const c = new HealthController([{ name: 'kafka', check: async () => false }]);
    await expect(c.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('AllExceptionsFilter', () => {
  it('mapea DomainError a status + body uniforme', () => {
    const filter = new AllExceptionsFilter(createLogger('test', 'silent'));
    let captured: { code?: number; body?: unknown } = {};
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (code: number) => ({ json: (body: unknown) => (captured = { code, body }) }),
        }),
        getRequest: () => ({ method: 'GET', url: '/trips/x' }),
      }),
    } as any;
    filter.catch(new NotFoundError('viaje no existe'), host);
    expect(captured.code).toBe(404);
    expect((captured.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('respeta el status de errores http-errors (body-parser PayloadTooLarge → 413, no 500)', () => {
    const filter = new AllExceptionsFilter(createLogger('test', 'silent'));
    let captured: { code?: number; body?: unknown } = {};
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (code: number) => ({ json: (body: unknown) => (captured = { code, body }) }),
        }),
        getRequest: () => ({ method: 'POST', url: '/webhooks/prontopaga' }),
      }),
    } as any;
    // body-parser lanza un Error plano con `status`/`statusCode` 413 y `type` (no es HttpException).
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
      expose: true,
    });
    filter.catch(tooLarge, host);
    expect(captured.code).toBe(413);
    expect((captured.body as { error: { code: string } }).error.code).toBe('HTTP_413');
  });
});

describe('LoggingInterceptor · statusFromError (el log refleja el status REAL, no 500 hardcodeado)', () => {
  it('HttpException → su status real (BadRequest → 400, no 500)', () => {
    expect(statusFromError(new BadRequestException('phone inválido'))).toBe(400);
    expect(statusFromError(new ServiceUnavailableException())).toBe(503);
  });
  it('DomainError → su httpStatus (NotFound → 404)', () => {
    expect(statusFromError(new NotFoundError('viaje no existe'))).toBe(404);
  });
  it('http-errors (body-parser, status 413) → 413', () => {
    const tooLarge = Object.assign(new Error('too large'), { status: 413, statusCode: 413 });
    expect(statusFromError(tooLarge)).toBe(413);
  });
  it('Error plano SIN status → 500 (el único 500 real)', () => {
    expect(statusFromError(new Error('boom'))).toBe(500);
    expect(statusFromError('not an error')).toBe(500);
  });
});
