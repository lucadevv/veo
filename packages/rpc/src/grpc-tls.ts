/**
 * gRPC interno TLS-capable POR ENV (un único helper compartido — DRY).
 *
 * El gRPC interno (BFF→servicio y servicio→servicio) ya tiene AUTH+INTEGRIDAD por HMAC
 * (`verifyGrpcIdentity`). Lo que falta es CONFIDENCIALIDAD de transporte: cifrar el canal.
 * Este módulo construye las credenciales de servidor/cliente con DEGRADACIÓN HONESTA:
 *
 *   - 3 rutas de cert presentes (CA + cert + key) → mTLS real (cifra + verifica el peer contra la CA).
 *   - ninguna ruta presente                       → insecure (texto plano). Caso dev/test.
 *   - entorno endurecido (prod) + sin certs       → WARN de boot claro (NUNCA finge mTLS).
 *   - ruta presente pero archivo roto/parcial     → fail-fast tipado (no degradar en silencio).
 *
 * mTLS se ACTIVA en prod provisionando GRPC_TLS_* (CA interna + cert por servicio). El código ya es
 * TLS-capable HOY; la PKI es un paso de DEPLOY diferido. Ver ADR-016.
 *
 * Lo consumen, sin duplicación: la factoría de clientes (`grpc-client.ts`) y los 12 `main.ts` de los
 * servidores gRPC (`buildGrpcServerCredentials`).
 */
import { readFileSync } from 'node:fs';
import { ServerCredentials, credentials, type ChannelCredentials } from '@grpc/grpc-js';
import { ValidationError, isHardenedEnv } from '@veo/utils';
import { createLogger } from '@veo/observability';

/**
 * Las 3 rutas del contrato de env `GRPC_TLS_*`. TODAS opcionales: ausentes (las 3) = insecure.
 * Presentes (las 3) = mTLS. Mezcla (1-2 de 3) = fail-fast (config parcial = deploy roto).
 */
export interface GrpcTlsPaths {
  /** PEM de la CA interna — raíz de confianza mutua. `GRPC_TLS_CA_PATH`. */
  caPath?: string;
  /** PEM del certificado de ESTE servicio/cliente. `GRPC_TLS_CERT_PATH`. */
  certPath?: string;
  /** PEM de la clave privada de ESTE servicio/cliente. `GRPC_TLS_KEY_PATH`. */
  keyPath?: string;
}

/** Modo de transporte resuelto (tipado — sin string mágico). */
export type GrpcTlsMode = 'mtls' | 'insecure';

/** Puerto de log mínimo para el WARN de boot. Un `Logger` de pino (@veo/observability) es asignable. */
export interface GrpcTlsLogger {
  warn(msg: string): void;
}

const DEFAULT_LOGGER: GrpcTlsLogger = createLogger('grpc-tls');

/**
 * Latch del WARN de "mTLS no configurado": se emite UNA vez por PROCESO, no por cada cliente construido.
 * Sin esto, un BFF con ~12 clientes gRPC warnearía 12 veces al boot. El fail-fast (required / cert roto)
 * NUNCA se dedupea — siempre lanza.
 */
let insecureWarnEmitted = false;

/** SOLO para tests: resetea el latch del WARN once-per-process. NO usar en runtime. */
export function resetGrpcTlsWarnLatchForTests(): void {
  insecureWarnEmitted = false;
}

/**
 * Extrae las 3 rutas del entorno (default `process.env`). Inyectable para tests. Ausentes = `undefined`.
 * Es el ÚNICO punto que lee los nombres `GRPC_TLS_*` del entorno (sin string mágico esparcido).
 */
export function grpcTlsPathsFromEnv(
  source: Record<string, string | undefined> = process.env,
): GrpcTlsPaths {
  return {
    caPath: source.GRPC_TLS_CA_PATH,
    certPath: source.GRPC_TLS_CERT_PATH,
    keyPath: source.GRPC_TLS_KEY_PATH,
  };
}

/**
 * ¿El operador EXIGE mTLS? (`GRPC_TLS_REQUIRED=true`). Lever de ENFORCEMENT: una vez provisionada la PKI, el
 * operador lo prende y el servicio RECHAZA arrancar en texto plano (fail-fast) si faltan los certs. Default
 * `false` (soft): permite deployar prod ANTES de tener certs y NO rompe dev/preview. Único lector de la var.
 */
export function grpcTlsRequiredFromEnv(
  source: Record<string, string | undefined> = process.env,
): boolean {
  return source.GRPC_TLS_REQUIRED === 'true';
}

interface ResolvedTls {
  readonly mode: GrpcTlsMode;
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
}

/** Núcleo compartido por servidor y cliente: decide el modo y lee los certs (con error tipado). */
function resolveTls(paths: GrpcTlsPaths, logger: GrpcTlsLogger, required: boolean): ResolvedTls {
  const present = [paths.caPath, paths.certPath, paths.keyPath].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );

  if (present.length === 0) {
    // ENFORCEMENT: mTLS exigido (GRPC_TLS_REQUIRED=true) pero sin certs → fail-fast. El servicio NO
    // arranca en texto plano. Nunca se dedupea (es un boot roto, debe lanzar siempre).
    if (required) {
      throw new ValidationError(
        'mTLS de gRPC REQUERIDO (GRPC_TLS_REQUIRED=true) pero GRPC_TLS_* NO provisionado: el servicio ' +
          'NO arranca en texto plano. Provisioná CA + cert + key (GRPC_TLS_CA_PATH/CERT_PATH/KEY_PATH) ' +
          'o bajá el flag (GRPC_TLS_REQUIRED=false) para permitir insecure en pre-PKI.',
        { required: true, provided: 0 },
      );
    }
    // Sin enforcement: caso dev/test → insecure. Si el entorno es ENDURECIDO (prod) y aún no se exige
    // mTLS, WARN honesto UNA vez por proceso: corre en texto plano y lo DICE. NUNCA finge mTLS.
    if (isHardenedEnv() && !insecureWarnEmitted) {
      insecureWarnEmitted = true;
      logger.warn(
        'gRPC mTLS NO configurado: provisioná GRPC_TLS_CA_PATH/GRPC_TLS_CERT_PATH/GRPC_TLS_KEY_PATH ' +
          '(CA interna + cert por servicio) y prendé GRPC_TLS_REQUIRED=true para forzarlo. El gRPC ' +
          'interno corre en TEXTO PLANO (solo HMAC, sin cifrado).',
      );
    }
    return { mode: 'insecure' };
  }

  // Config PARCIAL (1-2 de 3): fail-fast. Degradar a insecure ocultaría un deploy a medio provisionar.
  if (present.length < 3) {
    throw new ValidationError(
      'configuración TLS de gRPC PARCIAL: se requieren las 3 rutas ' +
        '(GRPC_TLS_CA_PATH, GRPC_TLS_CERT_PATH, GRPC_TLS_KEY_PATH) o NINGUNA. ' +
        `Provistas: ${present.length}/3.`,
      { provided: present.length },
    );
  }

  // 3 rutas presentes → mTLS. Leer los archivos con error tipado: ruta provista pero archivo
  // inexistente/ilegible = fail-fast (no degradar a texto plano en silencio).
  return {
    mode: 'mtls',
    ca: readCert(paths.caPath as string, 'GRPC_TLS_CA_PATH'),
    cert: readCert(paths.certPath as string, 'GRPC_TLS_CERT_PATH'),
    key: readCert(paths.keyPath as string, 'GRPC_TLS_KEY_PATH'),
  };
}

function readCert(path: string, envName: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new ValidationError(
      `no se pudo leer el cert de gRPC (${envName}=${path}): archivo inexistente o ilegible. ` +
        'Con la ruta provista pero el archivo roto, fail-fast (no degradar a texto plano).',
      { envName, path, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

/**
 * Credenciales del SERVIDOR gRPC (los 12 `main.ts`). Con certs → mTLS: exige y VERIFICA el cert del
 * cliente contra la CA interna (`checkClientCertificate=true`). Sin certs → insecure.
 */
export function buildGrpcServerCredentials(
  paths: GrpcTlsPaths = grpcTlsPathsFromEnv(),
  logger: GrpcTlsLogger = DEFAULT_LOGGER,
  required: boolean = grpcTlsRequiredFromEnv(),
): ServerCredentials {
  const tls = resolveTls(paths, logger, required);
  if (tls.mode === 'insecure') return ServerCredentials.createInsecure();
  return ServerCredentials.createSsl(
    tls.ca as Buffer,
    [{ private_key: tls.key as Buffer, cert_chain: tls.cert as Buffer }],
    true,
  );
}

/**
 * Credenciales del CLIENTE gRPC (la factoría `grpc-client.ts`, que cubre los 15 clientes). Con certs →
 * mTLS: presenta el cert del cliente + verifica el server contra la CA interna. Sin certs → insecure.
 */
export function buildGrpcClientCredentials(
  paths: GrpcTlsPaths = grpcTlsPathsFromEnv(),
  logger: GrpcTlsLogger = DEFAULT_LOGGER,
  required: boolean = grpcTlsRequiredFromEnv(),
): ChannelCredentials {
  const tls = resolveTls(paths, logger, required);
  if (tls.mode === 'insecure') return credentials.createInsecure();
  return credentials.createSsl(tls.ca as Buffer, tls.key as Buffer, tls.cert as Buffer);
}
