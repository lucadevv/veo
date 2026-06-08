/**
 * Cliente FCM HTTP v1 propio: obtiene el access token OAuth2 con google-auth-library y publica
 * vía fetch (Node 20). Sin SDK de Firebase. Riel externo inevitable (Google) tras puerto propio.
 *
 * Devuelve un `PushResult` TIPADO (no lanza por rechazos del riel): traduce el status/errorCode de
 * FCM v1 a accepted/invalidToken/rateLimited/transient para que el motor decida sin parsear strings.
 *
 * Convención: los códigos de FCM y los valores de protocolo viven en objetos `as const` nombrados,
 * nunca como string literals sueltos (un typo en un código externo falla en silencio).
 */
import { GoogleAuth, type JWTInput } from 'google-auth-library';
import {
  PushOutcome,
  PushTargetKind,
  type PushMessage,
  type PushResult,
  type PushTarget,
  type PushTransport,
} from './push.port';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_SEND_URL = (projectId: string): string =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

/** errorCode del cuerpo de error de FCM v1 (contrato externo de Google). */
const FcmErrorCode = {
  Unregistered: 'UNREGISTERED',
  NotFound: 'NOT_FOUND',
  SenderIdMismatch: 'SENDER_ID_MISMATCH',
  QuotaExceeded: 'QUOTA_EXCEEDED',
  ResourceExhausted: 'RESOURCE_EXHAUSTED',
  Unavailable: 'UNAVAILABLE',
  Internal: 'INTERNAL',
  ThirdPartyAuthError: 'THIRD_PARTY_AUTH_ERROR',
} as const;

/** Valores de protocolo APNs/Android dentro del payload FCM (no strings sueltos). */
const ApnsHeader = { PushTypeAlert: 'alert', PriorityImmediate: '10' } as const;
const ANDROID_PRIORITY_HIGH = 'high';
const PUSH_SOUND_DEFAULT = 'default';

/** Status HTTP relevantes (legibilidad sobre números mágicos). */
const HttpStatus = { NotFound: 404, TooManyRequests: 429, ServerErrorFloor: 500 } as const;

/** Códigos de token MUERTO → borrar, no reintentar (no INVALID_ARGUMENT: puede ser bug de payload propio). */
const INVALID_TOKEN_CODES = new Set<string>([
  FcmErrorCode.Unregistered,
  FcmErrorCode.NotFound,
  FcmErrorCode.SenderIdMismatch,
]);
/** Códigos de condición transitoria → reintentar con backoff. */
const TRANSIENT_CODES = new Set<string>([
  FcmErrorCode.Unavailable,
  FcmErrorCode.Internal,
  FcmErrorCode.ThirdPartyAuthError,
]);
/** Códigos de cuota/throttling → reintentar respetando Retry-After. */
const RATE_LIMITED_CODES = new Set<string>([FcmErrorCode.QuotaExceeded, FcmErrorCode.ResourceExhausted]);

export interface FcmConfig {
  projectId: string;
  /** JSON inline de la service account (opcional; si falta usa GOOGLE_APPLICATION_CREDENTIALS). */
  serviceAccountJson?: string;
}

/** Campo destino del `message` de FCM v1 según el tipo de target (token | topic | condition). */
function fcmDestination(target: PushTarget): Record<string, string> {
  switch (target.kind) {
    case PushTargetKind.Token:
      return { token: target.token };
    case PushTargetKind.Topic:
      return { topic: target.topic };
    case PushTargetKind.Condition:
      return { condition: target.condition };
  }
}

/** Extrae el errorCode del cuerpo de error de FCM v1 (`error.details[].errorCode` o `error.status`). */
function extractFcmErrorCode(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) return '';
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return '';
    const details = (error as { details?: unknown }).details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const code = (d as { errorCode?: unknown })?.errorCode;
        if (typeof code === 'string' && code.length > 0) return code;
      }
    }
    const status = (error as { status?: unknown }).status;
    return typeof status === 'string' ? status : '';
  } catch {
    return '';
  }
}

export class FcmClient implements PushTransport {
  private readonly auth: GoogleAuth;

  constructor(private readonly cfg: FcmConfig) {
    this.auth = new GoogleAuth({
      scopes: [FCM_SCOPE],
      credentials: cfg.serviceAccountJson
        ? (JSON.parse(cfg.serviceAccountJson) as JWTInput)
        : undefined,
    });
  }

  async send(msg: PushMessage): Promise<PushResult> {
    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      // Falla de credenciales propias (no del riel): transitoria, reintentable.
      return { outcome: PushOutcome.Transient, reason: 'FCM: no se pudo obtener access token OAuth2' };
    }

    // Bloque `apns`/`android` EXPLÍCITO: fuerza entrega visible y prioridad alta (sin esto, la entrega
    // en background iOS queda a merced de la heurística de FCM). El destino (token/topic/condition) lo
    // resuelve `fcmDestination`; FCM v1 acepta los tres en el MISMO endpoint y hace el fanout de topic.
    const message = {
      ...fcmDestination(msg.target),
      notification: { title: msg.title, body: msg.body },
      ...(msg.data ? { data: msg.data } : {}),
      apns: {
        headers: { 'apns-priority': ApnsHeader.PriorityImmediate, 'apns-push-type': ApnsHeader.PushTypeAlert },
        payload: { aps: { sound: PUSH_SOUND_DEFAULT } },
      },
      android: { priority: ANDROID_PRIORITY_HIGH, notification: { sound: PUSH_SOUND_DEFAULT } },
    };

    let res: Response;
    try {
      res = await fetch(FCM_SEND_URL(this.cfg.projectId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      // Error de RED (no respuesta del riel): transitorio.
      return { outcome: PushOutcome.Transient, reason: `FCM red: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (res.ok) {
      const json: unknown = await res.json().catch(() => null);
      const name =
        json && typeof json === 'object' && typeof (json as { name?: unknown }).name === 'string'
          ? (json as { name: string }).name
          : undefined;
      return { outcome: PushOutcome.Accepted, ...(name ? { providerMessageId: name } : {}) };
    }

    const body = await res.text().catch(() => '');
    const code = extractFcmErrorCode(body);
    const reason = `FCM ${res.status} ${code || ''}: ${body.slice(0, 200)}`.trim();

    if (INVALID_TOKEN_CODES.has(code) || res.status === HttpStatus.NotFound) {
      return { outcome: PushOutcome.InvalidToken, reason };
    }
    if (res.status === HttpStatus.TooManyRequests || RATE_LIMITED_CODES.has(code)) {
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      return {
        outcome: PushOutcome.RateLimited,
        reason,
        ...(retryAfterMs && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      };
    }
    if (res.status >= HttpStatus.ServerErrorFloor || TRANSIENT_CODES.has(code)) {
      return { outcome: PushOutcome.Transient, reason };
    }
    // 4xx no clasificado (p. ej. INVALID_ARGUMENT por bug de payload NUESTRO): transitorio, NO borrar token.
    // Si fuera permanente, el motor lo cierra al agotar maxAttempts. No tiramos: el contrato es no-throw.
    return { outcome: PushOutcome.Transient, reason };
  }
}
