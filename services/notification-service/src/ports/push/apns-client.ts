/**
 * Cliente APNs HTTP/2 propio: usa `node:http2` (nativo) y firma el provider token JWT ES256 con
 * `node:crypto` (dsaEncoding ieee-p1363 → firma JOSE raw r||s). Sin librerías de terceros.
 * El token de proveedor se reutiliza ~50 min (Apple exige refresco < 60 min).
 *
 * Devuelve un `PushResult` TIPADO (no lanza por rechazos del riel): traduce el status/reason de APNs
 * a accepted/invalidToken/rateLimited/transient para que el motor decida sin parsear strings.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createSign } from 'node:crypto';
import { PushOutcome, PushTargetKind, type PushMessage, type PushResult, type PushTransport } from './push.port';

const TOKEN_TTL_SECONDS = 3_000; // ~50 min

/** `reason` del cuerpo de error de APNs (contrato externo de Apple). */
const ApnsReason = {
  BadDeviceToken: 'BadDeviceToken',
  Unregistered: 'Unregistered',
  DeviceTokenNotForTopic: 'DeviceTokenNotForTopic',
} as const;

/** Valores de protocolo APNs (no strings sueltos). */
const ApnsPushType = { Alert: 'alert' } as const;
const APNS_PRIORITY_IMMEDIATE = '10';
const APNS_SOUND_DEFAULT = 'default';

/** Status HTTP/2 de APNs relevantes. */
const ApnsStatus = { Ok: 200, Gone: 410, TooManyRequests: 429 } as const;

/** `reason` de APNs que significan token MUERTO → borrar, no reintentar. */
const INVALID_TOKEN_REASONS = new Set<string>([
  ApnsReason.BadDeviceToken,
  ApnsReason.Unregistered,
  ApnsReason.DeviceTokenNotForTopic,
]);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Extrae el `reason` del cuerpo de error de APNs (`{ "reason": "BadDeviceToken" }`). */
function extractApnsReason(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const reason = (parsed as { reason?: unknown })?.reason;
    return typeof reason === 'string' ? reason : '';
  } catch {
    return '';
  }
}

export interface ApnsConfig {
  keyP8: string; // PEM de la clave EC P-256 (.p8)
  keyId: string;
  teamId: string;
  bundleId: string; // apns-topic
  host: string; // https://api.push.apple.com | https://api.sandbox.push.apple.com
}

export class ApnsClient implements PushTransport {
  private cachedToken?: string;
  private cachedAt = 0;

  constructor(private readonly cfg: ApnsConfig) {}

  private providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && now - this.cachedAt < TOKEN_TTL_SECONDS) return this.cachedToken;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.cfg.teamId, iat: now }));
    const signingInput = `${header}.${claims}`;
    const signer = createSign('SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign({ key: this.cfg.keyP8, dsaEncoding: 'ieee-p1363' });
    this.cachedToken = `${signingInput}.${base64url(signature)}`;
    this.cachedAt = now;
    return this.cachedToken;
  }

  async send(msg: PushMessage): Promise<PushResult> {
    if (msg.target.kind !== PushTargetKind.Token) {
      // APNs directo NO tiene topics/broadcast (es exclusivo de FCM). No debería llegar acá (el ruteo
      // manda los topic-send a FCM); si llega, es error de ruteo → transitorio, no se entrega.
      return { outcome: PushOutcome.Transient, reason: 'APNs no soporta topic/condition (broadcast solo por FCM)' };
    }
    const token = msg.target.token;
    let session: ClientHttp2Session;
    try {
      session = connect(this.cfg.host);
    } catch (err) {
      return { outcome: PushOutcome.Transient, reason: `APNs conexión: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      return await this.request(session, token, msg);
    } finally {
      session.close();
    }
  }

  private request(session: ClientHttp2Session, token: string, msg: PushMessage): Promise<PushResult> {
    return new Promise((resolve) => {
      session.once('error', (err: Error) =>
        resolve({ outcome: PushOutcome.Transient, reason: `APNs sesión: ${err.message}` }),
      );
      const payload = JSON.stringify({
        aps: { alert: { title: msg.title, body: msg.body }, sound: APNS_SOUND_DEFAULT },
        ...msg.data,
      });
      const req = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.cfg.bundleId,
        'apns-push-type': ApnsPushType.Alert,
        'apns-priority': APNS_PRIORITY_IMMEDIATE,
      });
      let status = 0;
      let apnsId = '';
      let respBody = '';
      req.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        const id = headers['apns-id'];
        apnsId = typeof id === 'string' ? id : '';
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        respBody += chunk;
      });
      req.on('error', (err: Error) => resolve({ outcome: PushOutcome.Transient, reason: `APNs stream: ${err.message}` }));
      req.on('end', () => {
        if (status === ApnsStatus.Ok) {
          resolve({ outcome: PushOutcome.Accepted, ...(apnsId ? { providerMessageId: apnsId } : {}) });
          return;
        }
        const reason = extractApnsReason(respBody) || `status ${status}`;
        const detail = `APNs ${status}: ${reason}`;
        if (status === ApnsStatus.Gone || INVALID_TOKEN_REASONS.has(reason)) {
          resolve({ outcome: PushOutcome.InvalidToken, reason: detail });
        } else if (status === ApnsStatus.TooManyRequests) {
          resolve({ outcome: PushOutcome.RateLimited, reason: detail });
        } else {
          // 5xx y 4xx no clasificados → transitorio (no borramos token salvo reason conocido).
          resolve({ outcome: PushOutcome.Transient, reason: detail });
        }
      });
      req.end(payload);
    });
  }
}
