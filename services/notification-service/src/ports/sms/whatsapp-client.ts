/**
 * Adapter WhatsApp Cloud API (Meta Graph) — OTP por plantilla de AUTENTICACIÓN pre-aprobada.
 * Raw `fetch`, SIN SDK. Riel externo (Meta) tras puerto propio. Igual que Twilio: NO agrega retry
 * (el motor reintenta ante throw); SOLO timeout + mapeo a errores TIPADOS de @veo/utils.
 *
 * API oficial (anclada, no inventar):
 *   POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages   (version anclada, ej. v25.0)
 *   Auth: Authorization: Bearer {ACCESS_TOKEN}. Content-Type application/json.
 *   Body (plantilla de autenticación / OTP): messaging_product=whatsapp, type=template, con el CÓDIGO
 *   como parámetro del body + del botón copy_code (NO texto libre — la plantilla la aprueba Meta).
 *   Éxito: JSON { messages:[{ id, message_status }] }. Error: { error:{ message, type, code, fbtrace_id } }.
 *
 * ── DEUDA TÉCNICA (anclada en el ledger) ──────────────────────────────────────────────────────────
 * El puerto `SmsSender(to, message)` entrega la FRASE renderizada (ej. "Tu código VEO es 482913"),
 * pero la plantilla de WhatsApp necesita el CÓDIGO CRUDO como parámetro (no la frase). Mientras el
 * motor no pase datos estructurados (LOTE de identity-wiring), extraemos el código de 6 dígitos del
 * texto con `extractOtpCode`. El OTP de VEO es 6 dígitos numéricos (contrato del template `contact.otp`).
 *   • Gatillo de pago: cuando el ChannelDispatcher pase `payload.code` estructurado al SmsSender (o un
 *     puerto OTP dedicado), reemplazar la extracción por el campo tipado y borrar `extractOtpCode`.
 *   • Techo: solo OTP de 6 dígitos. Cualquier SMS WhatsApp no-OTP NO está soportado por este adapter.
 */
import { ExternalServiceError, RateLimitError, ValidationError } from '@veo/utils';
import type { SmsSender } from './sms.port';

const WHATSAPP_MESSAGES_URL = (version: string, phoneNumberId: string): string =>
  `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

/** Status HTTP relevantes. */
const HttpStatus = { TooManyRequests: 429 } as const;
/** code del envelope de Graph para throttling (contrato externo de Meta). */
const META_RATE_LIMIT_CODES = new Set<number>([4, 80007, 130429, 131048]);

/** Longitud del OTP de VEO (contrato del template `contact.otp`). */
const OTP_LENGTH = 6;
const OTP_REGEX = new RegExp(`\\b(\\d{${OTP_LENGTH}})\\b`);

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Nombre del template de autenticación pre-aprobado por Meta. */
  otpTemplate: string;
  /** Código de idioma del template (ej. 'es', 'es_PE'). */
  otpLang: string;
  /** Versión de Graph anclada (ej. 'v25.0'). */
  graphVersion: string;
  timeoutMs: number;
}

/**
 * Extrae el código OTP de 6 dígitos de la frase renderizada (ver DEUDA arriba). Lanza ValidationError
 * si no hay un código de 6 dígitos: es un error de PROGRAMACIÓN (template mal armado), NO transitorio —
 * reintentar nunca lo arreglaría, así que no debe disfrazarse de fallo de red.
 */
export function extractOtpCode(message: string): string {
  const match = OTP_REGEX.exec(message);
  const code = match?.[1];
  if (!code) {
    throw new ValidationError(
      `WhatsApp OTP: no se encontró un código de ${OTP_LENGTH} dígitos en el mensaje renderizado`,
    );
  }
  return code;
}

/** Enmascara un teléfono dejando solo los últimos 4 dígitos (PII §0.7) — para mensajes de error. */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `•••${tail}` : '•••';
}

/** Vista tipada del envelope de error de Graph (`{ error:{ message, code, ... } }`). */
function extractGraphError(rawBody: string): { code?: number; message?: string } {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return {};
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    return {
      ...(typeof code === 'number' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  } catch {
    return {};
  }
}

export class WhatsAppCloudSender implements SmsSender {
  private readonly url: string;

  constructor(private readonly cfg: WhatsAppConfig) {
    this.url = WHATSAPP_MESSAGES_URL(cfg.graphVersion, cfg.phoneNumberId);
  }

  /**
   * Envía el OTP por la plantilla de autenticación. NUNCA loguea el código ni el teléfono completo.
   * Lanza error TIPADO ante no-2xx: 429 / códigos de cuota → RateLimitError (reintentable), resto →
   * ExternalServiceError.
   */
  async send(to: string, message: string): Promise<void> {
    const code = extractOtpCode(message); // DEUDA: ver cabecera del archivo.
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: this.cfg.otpTemplate,
        language: { code: this.cfg.otpLang },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button',
            sub_type: 'copy_code',
            index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ExternalServiceError(
        `WhatsApp red (${maskPhone(to)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return; // Graph 200 con { messages:[{ id }] }: aceptado.

    const body = await res.text().catch(() => '');
    const { code: errCode, message: errMsg } = extractGraphError(body);
    const detail = `WhatsApp ${res.status}${errCode ? ` (${errCode})` : ''} → ${maskPhone(to)}: ${errMsg ?? body.slice(0, 200)}`;

    if (
      res.status === HttpStatus.TooManyRequests ||
      (errCode !== undefined && META_RATE_LIMIT_CODES.has(errCode))
    ) {
      throw new RateLimitError(detail);
    }
    throw new ExternalServiceError(detail);
  }
}
