/**
 * Adapter REST FIRMADO del puerto PaymentGateway — los COMANDOS/lecturas de payment que son REST (ADR-014
 * §5.5): el CHARGE (`POST /charge`) y el gate de DEUDA (`GET /debt`). Usa el patrón `InternalRestClient`
 * (@veo/rpc · HMAC, audiencia service-rail) que YA usa share-service para llamar notification — el dominio
 * NUNCA toca este cliente; sólo el adapter. La lectura por paymentId (gRPC GetPayment) vive en otro adapter
 * (grpc-payment-reader.ts), inyectado en el mismo provider compuesto.
 *
 * RIEL: la llamada es de SISTEMA (booking→payment, sin usuario final ni BFF detrás) → `service-rail`. La
 * identidad firmada es anónima de tipo 'passenger' (booking sirve el riel del pasajero que reserva); lo que
 * GATEA la llamada es la AUDIENCIA service-rail (verificada per-endpoint por @Audiences + AudienceGuard en
 * payment, fail-closed), no el tipo del principal.
 *
 * DINERO: Int céntimos PEN siempre (nunca float). IDEMPOTENCIA: el CHARGE lleva `dedupKey =
 * booking-charge:{bookingId}` (determinista) como Idempotency-Key → un reintento/timeout NO crea un cobro
 * nuevo (payment dedupea por `dedupKey @unique`). TIMEOUT explícito (constructor) → AbortController del
 * InternalRestClient; un timeout se traduce a ExternalServiceError (502, el caller decide la compensación).
 */
import { Logger } from '@nestjs/common';
import { ExternalServiceError } from '@veo/utils';
import { anonymousIdentity, InternalAudience, type AuthenticatedUser } from '@veo/auth';
import { InternalRestClient, DownstreamError } from '@veo/rpc';
import { deriveBookingChargeDedupKey } from '../../domain/payment-charge';
import {
  PaymentMethod,
  PaymentStatus,
  type ChargeInput,
  type ChargeResult,
  type DebtSummary,
  type PaymentGateway,
  type PaymentView,
} from './payment-gateway.port';

const SERVICE_RAIL = InternalAudience.SERVICE_RAIL;

/** Cuerpo EXACTO que espera `POST /api/v1/payments/charge` (ChargeDto de payment). Dinero en Int céntimos. */
interface ChargeBody {
  tripId: string;
  grossCents: number;
  method: PaymentMethod;
  dedupKey: string;
  userId: string;
  payerRef?: string;
  driverId?: string;
}

/** Respuesta de `POST /charge`: el Payment de payment-service. Sólo nos importan id + status (§5.4). */
interface PaymentResponse {
  id: string;
  status: string;
}

/** Respuesta de `GET /debt`: el DebtSummary de payment (`{ hasDebt, debts[], totalCents }`). */
interface DebtResponse {
  hasDebt: boolean;
  totalCents: number;
  debts: Array<{
    paymentId?: string;
    tripId: string;
    amountCents: number;
    reason: string;
    createdAt: string;
  }>;
}

/** Mapea un status crudo del wire a un PaymentStatus tipado; '' si no es un valor conocido del enum. */
function toPaymentStatus(raw: string): PaymentStatus | '' {
  return (Object.values(PaymentStatus) as string[]).includes(raw) ? (raw as PaymentStatus) : '';
}

/**
 * Adapter REST de los caminos REST del puerto. `getPayment` NO se implementa acá (es gRPC) — lo compone el
 * provider con el reader gRPC. Para mantener el adapter cohesivo, este exporta SÓLO charge + getDebt y el
 * provider arma el PaymentGateway final delegando getPayment al reader.
 */
export class RestPaymentGateway implements Pick<PaymentGateway, 'charge' | 'getDebt'> {
  private readonly logger = new Logger(RestPaymentGateway.name);
  private readonly client: InternalRestClient;
  private readonly identity: AuthenticatedUser;

  constructor(baseUrl: string, secret: string, timeoutMs = 5000, fetchImpl?: typeof fetch) {
    this.identity = anonymousIdentity('passenger');
    this.client = new InternalRestClient({
      baseUrl,
      secret,
      audience: SERVICE_RAIL,
      timeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const dedupKey = deriveBookingChargeDedupKey(input.bookingId);
    const body: ChargeBody = {
      // tripId = bookingId (UUID opaco para payment · §5.5). payment NO lo valida contra trip-service.
      tripId: input.bookingId,
      grossCents: input.grossCents,
      method: input.method,
      dedupKey,
      // payment recibe el pasajero como `userId` (el ChargeDto lo nombra así).
      userId: input.passengerId,
      ...(input.payerRef ? { payerRef: input.payerRef } : {}),
      ...(input.driverId ? { driverId: input.driverId } : {}),
    };
    try {
      const res = await this.client.post<PaymentResponse>('/payments/charge', {
        identity: this.identity,
        body,
        // Idempotency-Key = la MISMA dedupKey determinista: un reintento NO duplica el cobro.
        idempotencyKey: dedupKey,
      });
      return { paymentId: res.id, status: toPaymentStatus(res.status) || PaymentStatus.PENDING };
    } catch (err) {
      throw this.toExternalError(err, 'el CHARGE del carpooling');
    }
  }

  async getDebt(passengerId: string): Promise<DebtSummary> {
    try {
      // ON-BEHALF-OF (service-rail): booking firma identidad ANÓNIMA (userId='anonymous'), así que el
      // passengerId NO viaja en la identidad — debe viajar EXPLÍCITO. Va como QUERY PARAM `passengerId`.
      // payment lo respeta SÓLO para service-rail (caller de sistema confiable); para los rieles de cliente
      // (public/driver/admin) lo IGNORA y deriva el passengerId de la identidad firmada (anti-IDOR: un
      // pasajero NUNCA consulta deuda ajena). Sin esto, payment resolvía la deuda de 'anonymous' →
      // hasDebt:false SIEMPRE → el gate de deuda al reservar quedaba estructuralmente NULO (no bloqueaba a
      // ningún deudor). Espeja el `userId` que el CHARGE ya manda en el body.
      const res = await this.client.get<DebtResponse>('/payments/debt', {
        identity: this.identity,
        query: { passengerId },
      });
      return {
        hasDebt: res.hasDebt,
        totalCents: res.totalCents,
        items: (res.debts ?? []).map((d) => ({
          ...(d.paymentId ? { paymentId: d.paymentId } : {}),
          tripId: d.tripId,
          amountCents: d.amountCents,
          reason: d.reason,
          createdAt: d.createdAt,
        })),
      };
    } catch (err) {
      throw this.toExternalError(err, 'el gate de deuda al reservar');
    }
  }

  /**
   * Traduce un fallo del cliente REST a un error de dominio TIPADO de booking (502, reintentable), preservando
   * status/code del downstream en details. El caller decide la degradación: para el gate de deuda, fail-open
   * con observabilidad (reservar NO mueve plata); para el charge, compensación.
   */
  private toExternalError(err: unknown, what: string): ExternalServiceError {
    if (err instanceof DownstreamError) {
      return new ExternalServiceError(`payment-service rechazó ${what}`, {
        status: err.status,
        code: err.code,
      });
    }
    return new ExternalServiceError(`payment-service inaccesible para ${what}`, {
      cause: String(err),
    });
  }
}
