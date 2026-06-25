import { createHash } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError, uuidv7 } from '@veo/utils';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  anonymousIdentity,
  signInternalIdentity,
  type InternalAudience,
} from '@veo/auth';
import { LivenessAction } from '@veo/shared-types';
import {
  BIOMETRIC_PROVIDER,
  type BiometricChallenge,
  type BiometricDniMatchInput,
  type BiometricDniMatchResult,
  type BiometricEnrollInput,
  type BiometricPassiveEnrollResult,
  type BiometricEnrollResult,
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
 * Umbral de similitud coseno del face-match SANDBOX (sub-lote 3C). Dos embeddings deterministas derivados
 * de la MISMA imagen dan coseno 1; de imágenes distintas, ~0 (vectores quasi-ortogonales del hash). 0.99
 * exige prácticamente identidad de imagen → el sandbox da `matched=true` solo si la foto del DNI es la
 * misma que generó el embedding de referencia (degradación honesta, no un `true` mágico).
 */
const SANDBOX_MATCH_THRESHOLD = 0.99;

/** Similitud coseno entre dos vectores (ambos ya unitarios en el sandbox, pero no asumimos norma 1). */
function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embedding unitario DETERMINISTA derivado del hash de la entrada (foto o primer frame del reto): mismo
 * input → mismo vector, y depende realmente de la entrada (no es un valor mágico). Base de la degradación
 * HONESTA del sandbox: sin device ni modelos ONNX, igual produce un embedding estable y verificable.
 */
function deterministicEmbedding(seed: string): number[] {
  const out: number[] = [];
  let block = createHash('sha256').update(seed).digest();
  while (out.length < EMBEDDING_DIM) {
    for (let i = 0; i + 4 <= block.length && out.length < EMBEDDING_DIM; i += 4) {
      out.push(block.readUInt32BE(i) / 0xffffffff);
    }
    block = createHash('sha256').update(block).digest();
  }
  const norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

/**
 * Sandbox determinista (seleccionable por env VEO_BIOMETRIC_MODE=sandbox, documentado en Ola 1).
 * Permite verificación dev/CI sin device ni modelos ONNX. NO es un mock de tests:
 *  - El reto/enroll falla si `challengeId` contiene 'fail' (permite probar el bloqueo de turno y el 422 de enroll).
 *  - El embedding se deriva de forma DETERMINISTA del hash de la entrada (no hay valores mágicos).
 */
class BiometricSandboxProvider implements BiometricProvider {
  async createChallenge(): Promise<BiometricChallenge> {
    return {
      challengeId: uuidv7(),
      action: LivenessAction.TURN_LEFT,
      instructions: 'Gira lentamente la cabeza hacia la izquierda',
      expiresAt: new Date(Date.now() + SANDBOX_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Enrolamiento CON liveness en sandbox: degradación HONESTA — sin motor ONNX, simula que la prueba de
   * vida pasó (livenessPassed: true) y deriva el embedding del PRIMER frame (hash determinista). Si el
   * `challengeId` contiene 'fail', simula un liveness fallido (embedding null + reason) para poder probar
   * el 422 del enroll en dev/CI. No inventa un embedding cuando "falla": espeja el contrato del motor real.
   */
  async enrollWithLiveness(input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
    const takenAt = new Date().toISOString();
    if (input.challengeId.includes('fail')) {
      return {
        livenessPassed: false,
        embedding: null,
        reason: 'Prueba de vida no superada (sandbox)',
        takenAt,
      };
    }
    return {
      livenessPassed: true,
      embedding: deterministicEmbedding(input.frames[0] ?? ''),
      reason: null,
      takenAt,
    };
  }

  async embed(photo: string): Promise<number[]> {
    return deterministicEmbedding(photo);
  }

  async enrollPassive(photo: string): Promise<BiometricPassiveEnrollResult> {
    // Sandbox determinista: simula un SPOOF si el seed contiene 'spoof' (para testear el rechazo del
    // registro); si no, persona viva con embedding determinista. Mismo idioma que `verify` (seed 'fail').
    if (photo.includes('spoof')) {
      return { embedding: null, live: false, livenessChecked: true, score: 0.1, reason: 'spoof' };
    }
    return {
      embedding: deterministicEmbedding(photo),
      live: true,
      livenessChecked: true,
      score: 0.95,
      reason: null,
    };
  }

  async verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult> {
    const fail = input.challengeId.includes('fail');
    const score = fail ? 40 : 96;
    return { score, livenessPassed: !fail, matchPassed: !fail };
  }

  /**
   * Face-match DNI↔selfie en sandbox: degradación HONESTA y DETERMINISTA — sin motor ONNX no cotejamos
   * caras reales, pero el resultado depende de la entrada (no es un valor mágico): comparamos el embedding
   * de referencia GUARDADO contra el embedding DETERMINISTA derivado de la imagen del DNI (mismo hash que
   * usa enroll/embed). Si la imagen del DNI fuera la MISMA que se enroló, ambos embeddings coinciden y el
   * match da `true` con score alto — coherente con el flujo real. Score fijo alto (96) para el caso match,
   * bajo (40) para el no-match. Permite probar el binding en dev/CI sin device.
   */
  async matchDniFace(input: BiometricDniMatchInput): Promise<BiometricDniMatchResult> {
    const imageEmbedding = deterministicEmbedding(input.image);
    const matched = cosineSimilarity(imageEmbedding, input.referenceEmbedding) >= SANDBOX_MATCH_THRESHOLD;
    return matched
      ? { matched: true, score: 96, reason: null }
      : { matched: false, score: 40, reason: 'El rostro del DNI no coincide con la biometría enrolada (sandbox)' };
  }
}

/**
 * Distingue un abort por timeout (`AbortSignal.timeout`) de cualquier otro fallo de fetch.
 * `AbortSignal.timeout` aborta con un DOMException name 'TimeoutError'; undici, según la versión,
 * puede propagarlo como 'AbortError'. Aceptamos ambos sin recurrir a `any` (narrowing sobre unknown).
 */
function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Respuesta cruda de biometric-service POST /v1/verify (score en 0..1). */
interface VerifyServiceResponse {
  result: string;
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
  reason: string;
}

/** Respuesta cruda de biometric-service POST /v1/enroll (enrolamiento CON liveness). */
interface EnrollServiceResponse {
  livenessPassed: boolean;
  embedding: number[] | null;
  reason: string | null;
  takenAt: string;
}

/** Respuesta cruda de biometric-service POST /v1/enroll-passive (enrolamiento con liveness PASIVO/PAD). */
interface PassiveEnrollServiceResponse {
  embedding: number[] | null;
  dimensions: number;
  live: boolean;
  livenessChecked: boolean;
  spoofScore: number;
  reason: string | null;
}

/** Respuesta cruda de biometric-service POST /v1/face-match (score en 0..1). */
interface FaceMatchServiceResponse {
  matched: boolean;
  score: number;
  reason: string | null;
}

/**
 * Audiencia de RIEL de la llamada a biometric-service: es de SISTEMA (server-to-server, sin usuario
 * final ni BFF detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

/**
 * Señal interna (no error) para `/v1/embed`: el servicio respondió 422 (foto sin rostro claro). Se
 * resuelve a embedding vacío para que drivers.service lo traduzca a `no_face` (422 del conductor), en vez
 * de un 502 genérico. Symbol único → imposible de confundir con una respuesta válida (no es un string).
 */
const NO_FACE = Symbol('biometric.embed.no_face');

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
   * Usamos `anonymousIdentity('driver')` con audiencia `service-rail`: la llamada es de servicio (el
   * driverId real va en el body), así que basta probar que el caller conoce el secreto compartido +
   * frescura (anti-replay 30s) + el riel de sistema (aud verificada per-service, fail-closed). No reusamos
   * `@veo/rpc` InternalRestClient para conservar el patrón de timeout con `AbortSignal.timeout` (sin leak
   * de timer) y no acoplar este puerto al cliente gRPC.
   */
  private async request<T>(path: string, body: unknown): Promise<T> {
    const { header, signature } = signInternalIdentity(
      anonymousIdentity('driver'),
      this.internalSecret,
      SERVICE_RAIL,
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

  /**
   * Variante de `request` para `/v1/embed` que distingue el 422 "sin rostro procesable" del resto de
   * fallos. Es el ÚNICO endpoint cuyo 422 es responsabilidad del input del conductor (foto sin rostro),
   * no del servicio: lo devolvemos como `NO_FACE` para que el caller lo traduzca a embedding vacío. El
   * timeout/red sigue cayendo en el `catch` de `request`-style (ExternalServiceError 502).
   */
  private async requestWithNoFace<T>(
    path: string,
    body: unknown,
  ): Promise<T | typeof NO_FACE> {
    const { header, signature } = signInternalIdentity(
      anonymousIdentity('driver'),
      this.internalSecret,
      SERVICE_RAIL,
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
      if (isTimeoutAbort(err)) {
        throw new ExternalServiceError('biometric-service no respondió a tiempo', {
          timeoutMs: this.timeoutMs,
          path,
        });
      }
      throw new ExternalServiceError('biometric-service inaccesible', { cause: String(err) });
    }
    // 422 = la foto no contiene un rostro claro procesable (contrato real de /v1/embed). NO es un fallo
    // del servicio: el conductor debe reintentar la selfie. Lo señalamos para mapear a embedding vacío.
    if (res.status === 422) {
      return NO_FACE;
    }
    if (!res.ok) {
      throw new ExternalServiceError('biometric-service devolvió error', { status: res.status });
    }
    return (await res.json()) as T;
  }

  async createChallenge(): Promise<BiometricChallenge> {
    return this.request<BiometricChallenge>('/v1/liveness/challenge', {});
  }

  async enrollWithLiveness(input: BiometricEnrollInput): Promise<BiometricEnrollResult> {
    const out = await this.request<EnrollServiceResponse>('/v1/enroll', {
      driverId: input.driverId,
      challengeId: input.challengeId,
      frames: input.frames,
    });
    return {
      livenessPassed: out.livenessPassed,
      embedding: out.embedding,
      reason: out.reason,
      takenAt: out.takenAt,
    };
  }

  /**
   * Embedding de referencia de UNA foto (`POST /v1/embed`). Contrato real del biometric-service: si NO
   * detecta EXACTAMENTE un rostro claro (o la foto es inválida/grande) responde **422** con `detail`
   * legible (ver routes.py `_embed_single_face`); cualquier otro fallo (5xx/red/timeout/auth) NO es un
   * problema del rostro. Mapeo HONESTO (no a ciegas):
   *  - 422 → embedding VACÍO (`[]`): el conductor mandó una foto sin rostro procesable. drivers.service
   *    lo traduce a `UnprocessableEntityError('No detectamos tu rostro', { reason: 'no_face' })` por su
   *    gate `!embedding.length` — un 422 tipado para el conductor, NO un 502 genérico.
   *  - resto → `ExternalServiceError` (502): biometric-service caído/colgado degrada honesto, NO se
   *    enmascara como "sin rostro".
   */
  async embed(photo: string): Promise<number[]> {
    const out = await this.requestWithNoFace<{ embedding: number[] }>('/v1/embed', { photo });
    return out === NO_FACE ? [] : out.embedding;
  }

  /**
   * Enrolamiento del REGISTRO con liveness PASIVO (`POST /v1/enroll-passive`). El motor corre el PAD sobre
   * la foto ANTES del embedding: 200 con `embedding=null`+`live=false` = SPOOF (foto/pantalla); 200 con
   * `embedding` = persona viva; 422 (mismo contrato que /v1/embed) = sin rostro → `no_face`. La decisión la
   * toma el caller por booleanos (`livenessChecked`/`live`), no por el string `reason`.
   */
  async enrollPassive(photo: string): Promise<BiometricPassiveEnrollResult> {
    const out = await this.requestWithNoFace<PassiveEnrollServiceResponse>('/v1/enroll-passive', { photo });
    if (out === NO_FACE) {
      return { embedding: null, live: false, livenessChecked: false, score: 0, reason: 'no_face' };
    }
    return {
      embedding: out.embedding ?? null,
      live: out.live,
      livenessChecked: out.livenessChecked,
      score: out.spoofScore,
      reason: out.reason ?? null,
    };
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

  async matchDniFace(input: BiometricDniMatchInput): Promise<BiometricDniMatchResult> {
    const out = await this.request<FaceMatchServiceResponse>('/v1/face-match', {
      image: input.image,
      referenceEmbedding: input.referenceEmbedding,
    });
    // biometric-service entrega el score en 0..1; identity-service trabaja en 0..100 (igual que verify).
    return {
      matched: out.matched,
      score: Math.round(out.score * 100),
      reason: out.reason,
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
