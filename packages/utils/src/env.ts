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
  if (isHardenedEnv()) {
    return z
      .string()
      .min(1, 'secreto requerido en producción (configurar vía Secrets Manager)')
      .refine((v) => v !== devDefault, {
        message: 'no usar el secreto de desarrollo en producción',
      });
  }
  return z.string().default(devDefault);
}

/**
 * Entorno ENDURECIDO (internet-facing): `NODE_ENV=production` cubre preview Y prod (el tier real lo da el
 * env_file, no este flag). ÚNICO punto del repo que lee `process.env.NODE_ENV` para decidir el tier —
 * centralizado acá (tipado, testeable) para no esparcir el string mágico `'production'` por el código.
 * Dev/local → false (controles de fricción como step-up MFA o anti-replay estricto se relajan).
 */
export function isHardenedEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Tier de despliegue (EJE distinto al de endurecimiento): qué ambiente lógico es, no si es internet-facing. */
export type DeployTier = 'local' | 'preview' | 'production';

/**
 * Tier de despliegue, leído de `VEO_DEPLOY_TIER`. Distingue PREVIEW de PRODUCTION (cosa que `NODE_ENV` NO
 * puede: ambos son `production`/endurecidos). Default SEGURO = `production` (lo más restrictivo): un tier
 * solo es permisivo si se declara EXPLÍCITAMENTE `local` o `preview`; cualquier otra cosa (unset/desconocido)
 * cae a `production`. Único punto que lee la var — centralizado, sin string mágico esparcido.
 */
export function deployTier(): DeployTier {
  const t = process.env.VEO_DEPLOY_TIER;
  return t === 'local' || t === 'preview' ? t : 'production';
}

/** ¿Es el tier de PRODUCCIÓN real? Para gates de operaciones DESTRUCTIVAS que dev+preview SÍ permiten y prod NO. */
export function isProdTier(): boolean {
  return deployTier() === 'production';
}
