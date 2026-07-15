/**
 * Adaptador LIVE del puerto SMS: delega la entrega del OTP a notification-service vía el cliente
 * REST interno FIRMADO (@veo/rpc InternalRestClient), siguiendo la convención del repo
 * (gRPC-para-lecturas, REST-firmado-para-comandos). notification-service NO expone gRPC server;
 * su comando de encolado es `POST /api/v1/notifications`, protegido por InternalIdentityGuard.
 *
 * En vez de pasar la frase ya renderizada, reusamos la plantilla `contact.otp` del catálogo de
 * notification-service y le pasamos el CÓDIGO estructurado en `payload.code` + el teléfono destino
 * en `to`. notification renderiza y envía con su propio motor (dedup + retry + routing por canal).
 *
 * ESPEJO de identity-service `ports/sms/notification-sms-sender.ts` (mismo contrato, misma
 * extracción de OTP). Diferencia deliberada: la identidad sintética (ver constructor) usa el tipo
 * `passenger` (no `driver`), porque share-service NO es un servicio de conductor.
 */
import { Logger } from '@nestjs/common';
import { ExternalServiceError, RateLimitError, ValidationError } from '@veo/utils';
import {
  anonymousIdentity,
  InternalAudience,
  type AuthenticatedUser,
  type InternalAudience as InternalAudienceType,
} from '@veo/auth';
import { InternalRestClient, DownstreamError } from '@veo/rpc';
import type { SmsSender } from './sms.port';

/**
 * CONTRATO entre servicios (string estable). Estas constantes ESPEJAN el catálogo de
 * notification-service (`engine/template.catalog.ts` CONTACT_OTP / NotificationChannel.SMS /
 * NotificationPriority.Critical). share-service no puede importar de otro servicio, así que se
 * declaran acá como constantes TIPADAS locales (mismo patrón que identity-service). Si el catálogo
 * de notification cambia el nombre del template o el valor de prioridad, actualizar acá también.
 */
/**
 * Audiencia de RIEL del cliente REST interno: la llamada a notification-service es de SISTEMA
 * (servicio→servicio, sin usuario final ni BFF detrás) → `service-rail`. Const TIPADA
 * (InternalAudience.SERVICE_RAIL), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudienceType = InternalAudience.SERVICE_RAIL;
const CONTACT_OTP_TEMPLATE = 'contact.otp' as const;
const SMS_CHANNEL = 'SMS' as const;
/** NotificationPriority.Critical = 100: salta la cola del worker (orderBy priority desc). OTP UX. */
const CRITICAL_PRIORITY = 100 as const;
/** OTP VEO = 6 dígitos numéricos (utils.numericOtp(6)). */
const OTP_CODE_PATTERN = /\b(\d{6})\b/;

/** Cuerpo EXACTO que espera `POST /api/v1/notifications` (CreateNotificationDto de notification). */
interface CreateNotificationBody {
  recipientId: string;
  channel: typeof SMS_CHANNEL;
  template: typeof CONTACT_OTP_TEMPLATE;
  to: string;
  payload: { code: string };
  dedupKey?: string;
  priority: typeof CRITICAL_PRIORITY;
}

/** Respuesta 202 de notification (NotificationView): solo nos importa que aceptó. */
interface NotificationView {
  id: string;
  status: string;
}

/**
 * Enmascara el teléfono para logs: deja prefijo + últimos 2 dígitos. JAMÁS logueamos el código.
 * `+51987654321` → `+51*******21`.
 */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  const head = phone.slice(0, 3);
  const tail = phone.slice(-2);
  return `${head}${'*'.repeat(Math.max(phone.length - 5, 1))}${tail}`;
}

/**
 * DEUDA (heredada del puerto SmsSender): el puerto es `send(to, message)` y entrega la frase ya
 * renderizada, pero notification necesita el CÓDIGO crudo para su template `contact.otp` ({{code}}).
 * Mitigación: extraemos el código de 6 dígitos por regex. Lanza ValidationError (NO transitorio) si
 * no hay código — un fallo de programación, no de red, que no debe disfrazarse de reintentable.
 * TECHO: solo OTP de 6 dígitos numéricos. Los consumidores HOY (contacts.service: alta y reenvío de
 * OTP de contacto de confianza) mandan exactamente eso. El enlace de seguimiento en pánico (BR-S05)
 * NO pasa por este puerto: share lo encola al outbox como `panic.fanout_requested` y notification
 * hace el fan-out durable (ver share.service.createPanicFanout). GATILLO para pagarla: cuando el
 * puerto SmsSender threade el código estructurado, reemplazar la extracción por el campo tipado.
 */
function extractOtpCode(message: string): string {
  const match = OTP_CODE_PATTERN.exec(message);
  const code = match?.[1];
  if (!code) {
    throw new ValidationError(
      'No se pudo extraer el código OTP del mensaje para notification-service',
    );
  }
  return code;
}

export class NotificationSmsSender implements SmsSender {
  private readonly logger = new Logger('NotificationSmsSender');
  private readonly client: InternalRestClient;
  private readonly identity: AuthenticatedUser;

  constructor(baseUrl: string, secret: string, timeoutMs = 8000, fetchImpl?: typeof fetch) {
    // La llamada es servicio→servicio (no hay un usuario final): basta probar conocimiento del
    // secreto compartido + frescura (anti-replay del guard) + el riel de sistema (aud verificada
    // per-service, fail-closed). Lo que GATEA la llamada es la AUDIENCIA `service-rail`, no el tipo
    // del principal. Usamos identidad anónima 'passenger': share-service sirve el riel pasajero
    // (contactos de confianza / compartir con familia), NO es un servicio de conductor — por eso NO
    // copiamos el 'driver' de identity-service, que sí es driver-céntrico. La forma es sintética
    // (userId 'anonymous', sessionId vacío): señal honesta para audit de que no hay sesión real.
    this.identity = anonymousIdentity('passenger');
    this.client = new InternalRestClient({
      baseUrl,
      secret,
      audience: SERVICE_RAIL,
      timeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async send(to: string, message: string): Promise<void> {
    const code = extractOtpCode(message);
    const body: CreateNotificationBody = {
      // El destinatario del OTP de contacto de confianza es un teléfono que puede NO tener todavía
      // un registro de usuario: usamos el propio teléfono como recipientId (estable para dedup) y
      // el campo `to` como dirección de entrega real (E.164). El motor enruta por canal SMS al `to`.
      recipientId: to,
      channel: SMS_CHANNEL,
      template: CONTACT_OTP_TEMPLATE,
      to,
      payload: { code },
      // Dedup por teléfono + el código: un reenvío del MISMO OTP no duplica el SMS, pero un OTP
      // NUEVO (código distinto) sí sale. Alineado con el TTL del OTP de contacto (5 min).
      dedupKey: `otp:${to}:${code}`,
      priority: CRITICAL_PRIORITY,
    };

    try {
      const view = await this.client.post<NotificationView>('/notifications', {
        identity: this.identity,
        body,
        idempotencyKey: body.dedupKey,
      });
      this.logger.log(`OTP encolado en notification-service → ${maskPhone(to)} (id=${view.id})`);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // InternalRestClient normaliza los non-2xx a DownstreamError (status/code del cuerpo de error).
      // Traducimos a un error de dominio TIPADO de share, preservando status/code en details:
      //  - 429 → RateLimitError (el caller puede aplicar backoff; honesto sobre el throttling).
      //  - resto (5xx/4xx) → ExternalServiceError (502, fallo del riel downstream).
      if (err instanceof DownstreamError) {
        const details = { to: maskPhone(to), status: err.status, code: err.code };
        if (err.status === 429)
          throw new RateLimitError('notification-service rate-limited el OTP', details);
        throw new ExternalServiceError('notification-service rechazó el OTP', details);
      }
      // Fallo de red/timeout (AbortError) u otro: degradar honesto (502 reintentable) en vez de 500 opaco.
      throw new ExternalServiceError('notification-service inaccesible para el OTP', {
        to: maskPhone(to),
        cause: String(err),
      });
    }
  }
}
