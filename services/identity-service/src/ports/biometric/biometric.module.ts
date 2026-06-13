import { createHash } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError, uuidv7 } from '@veo/utils';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  anonymousIdentity,
  signInternalIdentity,
} from '@veo/auth';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricProvider,
  type BiometricVerifyInput,
  type BiometricVerifyResult,
} from './biometric.port';
import type { Env } from '../../config/env.schema';

/** Dimensión del embedding de referencia (ArcFace w600k_r50). */
const EMBEDDING_DIM = 512;
/** TTL del reto sandbox (s); se alinea con `challenge_ttl_seconds` del biometric-service. */
const SANDBOX_CHALLENGE_TTL_SECONDS = 60;

/**
 * Sandbox determinista (seleccionable por env VEO_BIOMETRIC_MODE=sandbox, documentado en Ola 1).
 * Permite verificación dev/CI sin device ni modelos ONNX. NO es un mock de tests:
 *  - El reto falla si `challengeId` contiene 'fail' (permite probar el bloqueo de turno).
 *  - El embedding se deriva de forma DETERMINISTA del hash de la foto (no hay valores mágicos).
 */
class BiometricSandboxProvider implements BiometricProvider {
  async createChallenge(): Promise<BiometricChallenge> {
    return {
      challengeId: uuidv7(),
      action: 'TURN_LEFT',
      instructions: 'Gira lentamente la cabeza hacia la izquierda',
      expiresAt: new Date(Date.now() + SANDBOX_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async embed(photo: string): Promise<number[]> {
    // Vector unitario derivado del hash de la foto: determinista y dependiente de la entrada.
    const out: number[] = [];
    let block = createHash('sha256').update(photo).digest();
    while (out.length < EMBEDDING_DIM) {
      for (let i = 0; i + 4 <= block.length && out.length < EMBEDDING_DIM; i += 4) {
        out.push(block.readUInt32BE(i) / 0xffffffff);
      }
      block = createHash('sha256').update(block).digest();
    }
    const norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  }

  async verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult> {
    const fail = input.challengeId.includes('fail');
    const score = fail ? 40 : 96;
    return { score, livenessPassed: !fail, matchPassed: !fail };
  }
}

/**
 * Distingue un abort por timeout (`AbortSignal.timeout`) de cualquier otro fallo de fetch.
 * `AbortSignal.timeout` aborta con un DOMException name 'TimeoutError'; undici, según la versión,
 * puede propagarlo como 'AbortError'. Aceptamos ambos sin recurrir a `any` (narrowing sobre unknown).
 */
function isTimeoutAbort(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}

/** Respuesta cruda de biometric-service POST /v1/verify (score en 0..1). */
interface VerifyServiceResponse {
  result: string;
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
  reason: string;
}

/** Live: llama al biometric-service PROPIO (Python/ONNX) por HTTP con su contrato real. */
export class BiometricServiceClient implements BiometricProvider {
  constructor(
    private readonly baseUrl: string,
    /** Timeout (ms) por request. Gate del shift-start: un proveedor colgado debe fallar rápido. */
    private readonly timeoutMs: number,
    /** Secreto HMAC compartido con biometric-service (INTERNAL_IDENTITY_SECRET). */
    private readonly internalSecret: string,
  ) {}

  /**
   * Firma la identidad interna (HMAC, esquema @veo/auth `signInternalIdentity`) y propaga los headers
   * `x-veo-identity` + `x-veo-identity-sig` — el biometric-service ahora EXIGE este gate (server-to-server).
   * Usamos `anonymousIdentity('driver')`: la llamada es de servicio (el driverId real va en el body), así
   * que basta probar que el caller conoce el secreto compartido + frescura (anti-replay 30s). No reusamos
   * `@veo/rpc` InternalRestClient para conservar el patrón de timeout con `AbortSignal.timeout` (sin leak
   * de timer) y no acoplar este puerto al cliente gRPC.
   */
  private async request<T>(path: string, body: unknown): Promise<T> {
    const { header, signature } = signInternalIdentity(
      anonymousIdentity('driver'),
      this.internalSecret,
    );
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_IDENTITY_HEADER]: header,
          [INTERNAL_IDENTITY_SIG_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // El abort por timeout llega acá como AbortError/TimeoutError: lo traducimos a un error de
      // dominio tipado (502 EXTERNAL, reintentable) para que shift-start/KYC degraden HONESTO en
      // vez de colgarse o devolver un 500 opaco. No relajamos el gate: el turno NO arranca, pero
      // falla rápido y claro.
      if (isTimeoutAbort(err)) {
        throw new ExternalServiceError('biometric-service no respondió a tiempo', {
          timeoutMs: this.timeoutMs,
          path,
        });
      }
      throw new ExternalServiceError('biometric-service inaccesible', { cause: String(err) });
    }
    if (!res.ok) {
      throw new ExternalServiceError('biometric-service devolvió error', { status: res.status });
    }
    return (await res.json()) as T;
  }

  async createChallenge(): Promise<BiometricChallenge> {
    return this.request<BiometricChallenge>('/v1/liveness/challenge', {});
  }

  async embed(photo: string): Promise<number[]> {
    const out = await this.request<{ embedding: number[] }>('/v1/embed', { photo });
    return out.embedding;
  }

  async verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult> {
    const out = await this.request<VerifyServiceResponse>('/v1/verify', {
      driverId: input.driverId,
      challengeId: input.challengeId,
      frames: input.frames,
      referenceEmbedding: input.referenceEmbedding,
    });
    // biometric-service entrega el score en 0..1; identity-service trabaja en 0..100 (BR-I02).
    return {
      score: Math.round(out.score * 100),
      livenessPassed: out.livenessPassed,
      matchPassed: out.matchPassed,
    };
  }
}

const biometricProvider: Provider = {
  provide: BIOMETRIC_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): BiometricProvider =>
    config.getOrThrow<string>('VEO_BIOMETRIC_MODE') === 'live'
      ? new BiometricServiceClient(
          config.getOrThrow<string>('BIOMETRIC_SERVICE_URL'),
          config.getOrThrow<number>('BIOMETRIC_TIMEOUT_MS'),
          config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
        )
      : new BiometricSandboxProvider(),
};

@Module({ providers: [biometricProvider], exports: [BIOMETRIC_PROVIDER] })
export class BiometricModule {}
