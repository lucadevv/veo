import { z } from 'zod';

/**
 * Secreto de configuración con default SOLO en desarrollo/test. En PRODUCCIÓN (NODE_ENV=production) el
 * default de dev NO aplica: el secreto es REQUERIDO y se RECHAZA explícitamente el valor de desarrollo
 * (fail-fast en el arranque). Así un servicio NUNCA puede levantar en prod con un HMAC/clave de
 * desarrollo conocido (forjable) por omisión de configuración — debe venir de Secrets Manager.
 *
 * Uso en el env schema:
 *   INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),
 * En dev/test usa el default; en prod, si falta o es el de dev, el servicio no arranca (z.parse lanza).
 */
export function secret(devDefault: string) {
  if (process.env.NODE_ENV === 'production') {
    return z
      .string()
      .min(1, 'secreto requerido en producción (configurar vía Secrets Manager)')
      .refine((v) => v !== devDefault, {
        message: 'no usar el secreto de desarrollo en producción',
      });
  }
  return z.string().default(devDefault);
}
