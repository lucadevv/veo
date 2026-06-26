import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Secreto de configuración con default SOLO en desarrollo/test. En PRODUCCIÓN (NODE_ENV=production) el
 * default de dev NO aplica: el secreto es REQUERIDO y se RECHAZA explícitamente el valor de desarrollo
 * (fail-fast en el arranque). Así un servicio NUNCA puede levantar en prod con un HMAC/clave de
 * desarrollo conocido (forjable) por omisión de configuración — debe venir del secret store self-hosted
 * (`.env` del host / docker-secrets / SOPS+age).
 *
 * Uso en el env schema:
 *   INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),
 * En dev/test usa el default; en prod, si falta o es el de dev, el servicio no arranca (z.parse lanza).
 */
export function secret(devDefault: string) {
  if (isHardenedEnv()) {
    return z
      .string()
      .min(1, 'secreto requerido en producción (configurar vía secret store self-hosted: .env del host / docker-secrets / SOPS+age)')
      .refine((v) => v !== devDefault, {
        message: 'no usar el secreto de desarrollo en producción',
      });
  }
  return z.string().default(devDefault);
}

/**
 * Config de infra REQUERIDA con default SOLO en desarrollo/test. Mismo fail-fast que `secret()` pero para
 * valores NO sensibles (no se redactan, no son credenciales): endpoints/brokers/URLs de dependencias que el
 * servicio DEBE recibir del entorno en producción. En PRODUCCIÓN (NODE_ENV=production) el default de dev NO
 * aplica: el valor es REQUERIDO y se RECHAZA el default de desarrollo (típicamente `localhost`) → el servicio
 * NO arranca apuntando a una dependencia FANTASMA (ej. `KAFKA_BROKERS=localhost:9094` en prod = eventos al
 * vacío en silencio, sin error). En dev/test usa el default y no rompe el arranque local/CI.
 *
 * `secret()` es para CREDENCIALES (HMAC/claves, valor sensible); esto es para INFRA (a dónde me conecto). La
 * semántica de fail-fast es idéntica; la diferencia es el dato que protege y el mensaje de error.
 *
 * `opts.url: true` preserva la validación `.url()` para endpoints HTTP (mismo fail-fast, además exige URL
 * bien formada). Omitir para valores que NO son URL (ej. `host:port` de Kafka, o `host:port` de gRPC).
 *
 * Uso en el env schema:
 *   KAFKA_BROKERS: requiredInProd('localhost:9094'),
 *   NOTIFICATION_INTERNAL_URL: requiredInProd('http://localhost:3008/api/v1', { url: true }),
 */
export function requiredInProd(devDefault: string, opts?: { url?: boolean }) {
  const base = opts?.url ? z.string().url() : z.string();
  if (isHardenedEnv()) {
    return base
      .min(1, 'config de infra requerida en producción (configurar vía entorno/configmap)')
      .refine((v) => v !== devDefault, {
        message: `no usar el valor de desarrollo ("${devDefault}") en producción: apunta a una dependencia inexistente`,
      });
  }
  return base.default(devDefault);
}

/**
 * Fragmento de schema zod con el contrato del transporte TLS de gRPC interno (ADR-016). Las 3 rutas son
 * OPCIONALES: ausentes (las 3) = insecure (dev/test); presentes (las 3) = mTLS; mezcla = fail-fast en el
 * helper `buildGrpc*Credentials` (@veo/rpc). Cada servicio/BFF que hace gRPC (servidor y/o cliente) lo
 * spreadea en su env.schema (FUENTE ÚNICA del contrato, DRY):
 *   z.object({ ...otrasVars, ...grpcTlsEnvSchema.shape })
 * El VALOR efectivo lo lee `grpcTlsPathsFromEnv()` de `process.env` (mismo patrón que GRPC_URL); este
 * fragmento DOCUMENTA y valida el contrato (3 strings opcionales) sin acoplar el helper al ConfigService.
 */
export const grpcTlsEnvSchema = z.object({
  /** PEM de la CA interna (raíz de confianza mutua del mTLS). Ausente = insecure. */
  GRPC_TLS_CA_PATH: z.string().optional(),
  /** PEM del certificado de ESTE servicio/cliente. Ausente = insecure. */
  GRPC_TLS_CERT_PATH: z.string().optional(),
  /** PEM de la clave privada de ESTE servicio/cliente. Ausente = insecure. */
  GRPC_TLS_KEY_PATH: z.string().optional(),
  /**
   * Lever de ENFORCEMENT de mTLS. `true` + certs ausentes → el servicio NO arranca (fail-fast en
   * `buildGrpc*Credentials`): prohíbe el texto plano en prod una vez provisionada la PKI. Default `false`
   * (soft): permite deployar prod ANTES de tener certs y no rompe dev/preview. Ley 29733 (TLS interno).
   */
  GRPC_TLS_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

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
 * izquierda descartando los hops cuya IP está en la lista (proxies de ingreso, todos privados) y
 * deja `req.ip` = la primera IP NO confiable = el cliente real. Un atacante que inyecte un XFF
 * (o cualquier header de IP) NO puede ganar: su IP pública nunca está en la lista de confianza, así
 * que no se descarta. Por eso el rate-limit debe leer `req.ip`, no headers crudos.
 *
 * TRUST-ALL PROHIBIDO: `trust proxy = true` (o `'*'`) hace que Express tome el PRIMER token del XFF
 * como `req.ip` SIN validar ningún hop → ese token lo controla el cliente = `req.ip` se vuelve un
 * header crudo SPOOFEABLE = rate-limit y audit log 100% evadibles. En el deploy de VEO (VPS + Docker
 * Compose, ingreso por Cloudflare Tunnel) trust-all NUNCA es válido: hay siempre un rango de confianza
 * concreto que expresar (la red interna de docker / el peer del túnel). Por eso este helper RECHAZA
 * trust-all al arranque (fail-fast) en vez de degradar a un `req.ip` forjable.
 *
 * CONTENCIÓN EN PROFUNDIDAD: en el deploy VPS la contención de red la dan (a) la red interna de Docker
 * Compose (los BFFs NO publican puertos al host), (b) el firewall del host (default-deny) y (c)
 * Cloudflare Tunnel como único ingreso (cloudflared alcanza los BFFs por la red docker). Así ningún
 * cliente arbitrario puede siquiera presentar un XFF directo al contenedor. El preset/CIDR de confianza
 * es la SEGUNDA capa: aun si la red se abriera, `req.ip` sigue resolviendo la IP real. Endurecimiento
 * ideal: el CIDR EXACTO de la red docker en vez de `uniquelocal` (que confía en TODO RFC1918).
 *
 * // TODO(vps): revisar TRUSTED_PROXY para Cloudflare Tunnel — el cliente real llega en CF-Connecting-IP,
 * // el peer es cloudflared en la red docker; ajustar trust-proxy a ese modelo.
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
  // este deploy (VPS + red docker interna + Cloudflare Tunnel). Fail-fast al boot, no degradar a una IP forjable.
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
