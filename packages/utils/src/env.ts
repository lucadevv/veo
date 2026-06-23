import { z } from 'zod';
import { ValidationError } from './errors.js';

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

/**
 * Valor para `app.set('trust proxy', …)` (Express/proxy-addr) a partir de un CSV de configuración.
 *
 * SEGURIDAD: con un set de proxies de confianza, Express camina el `X-Forwarded-For` de derecha a
 * izquierda descartando los hops cuya IP está en la lista (ALB + ingress-nginx, todos privados) y
 * deja `req.ip` = la primera IP NO confiable = el cliente real. Un atacante que inyecte un XFF
 * (o cualquier header de IP) NO puede ganar: su IP pública nunca está en la lista de confianza, así
 * que no se descarta. Por eso el rate-limit debe leer `req.ip`, no headers crudos.
 *
 * TRUST-ALL PROHIBIDO: `trust proxy = true` (o `'*'`) hace que Express tome el PRIMER token del XFF
 * como `req.ip` SIN validar ningún hop → ese token lo controla el cliente = `req.ip` se vuelve un
 * header crudo SPOOFEABLE = rate-limit y audit log 100% evadibles. En el deploy de VEO (ALB + k8s
 * ingress-nginx, SIN Cloudflare) trust-all NUNCA es válido: el cliente real tiene IP pública y los
 * proxies IP privada, así que SIEMPRE hay un rango de confianza concreto que expresar. Por eso este
 * helper RECHAZA trust-all al arranque (fail-fast) en vez de degradar a un `req.ip` forjable.
 *
 * CONTENCIÓN EN PROFUNDIDAD: la confianza de red real la impone la NetworkPolicy
 * `infra/k8s/base/networkpolicies/east-west.yaml` (allow-bff-ingress) — SOLO ingress-nginx alcanza
 * el pod del BFF, así que ningún cliente arbitrario puede ni siquiera presentar un XFF al pod. El
 * preset/CIDR de confianza es la SEGUNDA capa: aun si la red se abriera, `req.ip` sigue resolviendo
 * la IP pública real. Endurecimiento ideal: el CIDR EXACTO del VPC/pod (ver configmaps por overlay)
 * en vez de `uniquelocal` (que confía en TODO RFC1918).
 *
 * Acepta:
 *  - presets de proxy-addr (`loopback`, `linklocal`, `uniquelocal`) y/o subredes CIDR (recomendado);
 *  - `'false'` (trust-none): `req.ip` = peer TCP directo. Válido y seguro (sin proxies de confianza).
 *  - un NÚMERO de hops de confianza (frágil en VPC — preferir rangos; se acepta por compatibilidad).
 *
 * Devuelve un único valor si el CSV trae uno solo, o el arreglo de valores.
 *
 * @throws {ValidationError} si algún token es `'true'`/`'*'` (trust-all): inseguro en este deploy.
 */
export function parseTrustedProxy(csv: string): boolean | number | string | Array<string | number> {
  const tokens = csv
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Trust-all (true / '*') hace `req.ip` = XFF crudo del cliente = spoofeable. Inválido SIEMPRE en
  // este deploy (VPC con proxies privados). Fail-fast al boot, no degradar a una IP forjable.
  const trustAll = tokens.find((t) => t === 'true' || t === '*');
  if (trustAll !== undefined) {
    throw new ValidationError(
      `TRUSTED_PROXY=${trustAll} (trust-all) es inseguro: hace req.ip = el X-Forwarded-For crudo del ` +
        `cliente (spoofeable, evade rate-limit y audit log). Usá presets de rango privado ` +
        `(loopback/linklocal/uniquelocal), CIDRs del VPC, o 'false' (trust-none).`,
      { value: trustAll },
    );
  }

  const coerced = tokens.map((t): string | number | boolean => {
    if (t === 'false') return false;
    if (/^\d+$/.test(t)) return Number(t);
    return t;
  });

  // Un único token booleano(false)/numérico/preset → pasarlo tal cual (Express trata el escalar especial).
  if (coerced.length === 1) return coerced[0] as boolean | number | string;
  // Varios tokens: Express/proxy-addr solo admite array de subredes/presets (strings) — un booleano
  // mezclado no tiene sentido; lo descartamos para no romper la compilación de la lista de confianza.
  return coerced.filter((t): t is string | number => typeof t !== 'boolean');
}
