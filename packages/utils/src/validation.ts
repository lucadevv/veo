/**
 * Helpers de validación con Zod, narrowing estructural + esquemas reutilizables del dominio peruano.
 */
import { z } from 'zod';
import { PLATE_PATTERN, PLATE_INVALID_MESSAGE } from '@veo/shared-types';
import { ValidationError } from './errors.js';

/**
 * Patrón y mensaje canónicos de placa peruana. FUENTE ÚNICA en `@veo/shared-types` (RN-safe, sin node:*):
 * se re-exportan acá para no romper a los backends que ya los importan de `@veo/utils`. La app RN los
 * importa DIRECTO de `@veo/shared-types` (importar `@veo/utils` arrastra node:crypto al bundle de Metro).
 */
export { PLATE_PATTERN, PLATE_INVALID_MESSAGE } from '@veo/shared-types';

/** Parsea con Zod y, si falla, lanza ValidationError de dominio (no ZodError crudo). */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context?: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(context ? `Validación falló: ${context}` : 'Validación falló', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/**
 * Narrowing estructural: ¿es un objeto plano (record) y no un array/null? Útil para tratar
 * `unknown` como `details` de un error público sin castear. Fuente única: antes vivía duplicado
 * en los ExceptionFilters de @veo/observability y @veo/rpc.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Teléfono móvil peruano: +51 9XXXXXXXX (9 dígitos empezando en 9). Normaliza a +51XXXXXXXXX. */
export const peruPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((d) => /^(51)?9\d{8}$/.test(d), 'Teléfono peruano inválido (formato +51 9XXXXXXXX)')
  .transform((d) => `+51${d.slice(-9)}`);

/** DNI peruano: 8 dígitos. */
export const dniSchema = z
  .string()
  .trim()
  .regex(/^\d{8}$/, 'DNI inválido (8 dígitos)');

/** Placa vehicular peruana: auto `ABC-123`/`A1B-234` o moto `7351-NB`. */
export const plateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PLATE_PATTERN, PLATE_INVALID_MESSAGE);

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** Código de modo niño: 4 a 6 dígitos (BR-T07). El hash se guarda, nunca el código. */
export const childCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'El código de modo niño debe tener 4 a 6 dígitos');
