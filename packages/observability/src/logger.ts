/**
 * Logger estructurado (pino) con redacción de PII (FOUNDATION §5, Ley 29733).
 * Nunca loguear phone, dni, password, token, email en claro.
 */
import { pino, type Logger } from 'pino';

/** Rutas a redactar en cualquier objeto logueado. */
export const PII_REDACT_PATHS = [
  'phone',
  'email',
  'dni',
  'dniHash',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'childCode',
  'childCodeHash',
  '*.phone',
  '*.email',
  '*.dni',
  '*.password',
  '*.token',
  'req.headers.authorization',
  'req.headers["x-veo-identity"]',
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: PII_REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type { Logger };
