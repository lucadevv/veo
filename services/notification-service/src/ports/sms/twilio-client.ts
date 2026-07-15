/**
 * Adapter Twilio SMS (raw `fetch`, SIN SDK de Twilio — riel liviano e intercambiable tras el puerto).
 * Riel externo inevitable (agregador SMS) tras puerto propio. NO mete una segunda capa de retry: el
 * motor de notificaciones ya reintenta ante cualquier throw (ChannelDispatcher.attempt → Transient).
 * Acá SOLO se pone timeout y se mapea no-2xx a errores TIPADOS de @veo/utils.
 *
 * API oficial (anclada, no inventar):
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Auth: HTTP Basic base64(AccountSid:AuthToken). Content-Type x-www-form-urlencoded.
 *   Params (PascalCase): To (E.164), From (E.164) | MessagingServiceSid (MG…), Body.
 *   Éxito: 201 JSON { sid, status, error_code, error_message }. Error: JSON { code, message, ... }.
 *   429 / code 20429 = rate limit (reintentable).
 */
import { ExternalServiceError, RateLimitError } from '@veo/utils';
import type { SmsSender } from './sms.port';

const TWILIO_MESSAGES_URL = (accountSid: string): string =>
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

/** Status HTTP / códigos Twilio relevantes (legibilidad sobre números mágicos). */
const HttpStatus = { TooManyRequests: 429 } as const;
/** code de Twilio para throttling (contrato externo). */
const TWILIO_RATE_LIMIT_CODE = 20429;

/**
 * Config del adapter. `from` y `messagingServiceSid` son EXCLUYENTES (uno u otro): Twilio acepta
 * `From` (número E.164) o `MessagingServiceSid` (MG…) — el módulo valida que haya exactamente uno.
 */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Número remitente E.164 (+1…). Excluyente con messagingServiceSid. */
  from?: string;
  /** Messaging Service SID (MG…). Excluyente con from. */
  messagingServiceSid?: string;
  timeoutMs: number;
}

/** Enmascara un teléfono dejando solo los últimos 4 dígitos (PII §0.7) — para mensajes de error. */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `•••${tail}` : '•••';
}

/** Vista tipada del cuerpo de error de Twilio (`{ code, message, ... }`). */
function extractTwilioError(rawBody: string): { code?: number; message?: string } {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const code = (parsed as { code?: unknown }).code;
    const message = (parsed as { message?: unknown }).message;
    return {
      ...(typeof code === 'number' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  } catch {
    return {};
  }
}

export class TwilioSmsSender implements SmsSender {
  private readonly authHeader: string;
  private readonly sender: { From: string } | { MessagingServiceSid: string };

  constructor(private readonly cfg: TwilioConfig) {
    this.authHeader = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
    // El módulo ya garantizó exactamente uno; resolvemos el campo del form acá una sola vez.
    this.sender = cfg.messagingServiceSid
      ? { MessagingServiceSid: cfg.messagingServiceSid }
      : { From: cfg.from as string };
  }

  /**
   * Envía un SMS. NUNCA loguea el Body (puede traer el OTP) ni el teléfono completo. Lanza error TIPADO
   * ante no-2xx para que el motor decida: 429/20429 → RateLimitError (reintentable), resto →
   * ExternalServiceError. La idempotencia la garantiza el dedupKey del motor (Twilio no expone header).
   */
  async send(to: string, message: string): Promise<void> {
    const form = new URLSearchParams({ To: to, Body: message, ...this.sender });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(TWILIO_MESSAGES_URL(this.cfg.accountSid), {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      // Error de RED / timeout (sin respuesta del riel): transitorio → el motor reintenta.
      throw new ExternalServiceError(
        `Twilio red (${maskPhone(to)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return; // 201 Created: aceptado por Twilio.

    const body = await res.text().catch(() => '');
    const { code, message: errMsg } = extractTwilioError(body);
    const detail = `Twilio ${res.status}${code ? ` (${code})` : ''} → ${maskPhone(to)}: ${errMsg ?? body.slice(0, 200)}`;

    if (res.status === HttpStatus.TooManyRequests || code === TWILIO_RATE_LIMIT_CODE) {
      throw new RateLimitError(detail);
    }
    throw new ExternalServiceError(detail);
  }
}
