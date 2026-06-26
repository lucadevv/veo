/**
 * Adapter LIVE del riel de DESEMBOLSO Yape/Plin (money-OUT · ADR-015 D2) — ESPEJO del `LivePaymentGateway`
 * del money-IN. DIFERIDO: bloqueado por convenio PSP, exactamente como el `charge` live (ADR-014 §11.3).
 *
 * El puerto + el sandbox + el ciclo de estados se construyen YA; este adapter se ENCHUFA el día del convenio
 * sin tocar el dominio. Hasta entonces NO cobra ni desembolsa a ciegas: `disburse` FALLA-RÁPIDO con un error
 * claro (NO silencio). En prod sin convenio, el operador no puede desembolsar lo que el riel no soporta aún
 * (ADR-015 §8, "el adapter live no está") — el disparo falla, no se marca un payout `PROCESSED` mentiroso.
 */
import { Logger } from '@nestjs/common';
import { ExternalServiceError } from '@veo/utils';
import type {
  PayoutGateway,
  DisburseRequest,
  DisburseResult,
} from './payout-gateway.port';

export interface YapePlinPayoutGatewayOptions {
  baseUrl?: string;
  apiKey?: string;
  merchantId?: string;
}

export class YapePlinPayoutGateway implements PayoutGateway {
  private readonly logger = new Logger('YapePlinPayoutGateway');

  constructor(private readonly opts: YapePlinPayoutGatewayOptions = {}) {}

  /**
   * Disponibilidad del riel (ADR-015 §8): el adapter live está DIFERIDO hasta el convenio PSP → NO
   * disponible. El dominio lo consulta PRE-CLAIM y, al ver `false`, rechaza el disparo ANTES de mover
   * un solo payout a PROCESSING (fail-fast honesto: ningún payout queda colgado). Esto reemplaza la
   * vieja causa raíz, donde `disburse` lanzaba DESPUÉS del claim y dejaba el payout PROCESSING colgado.
   */
  isAvailable(): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disburse(req: DisburseRequest): Promise<DisburseResult> {
    // Fail-fast honesto: el riel live de desembolso no está disponible hasta cerrar el convenio PSP.
    // ExternalServiceError (502) = "el upstream no está disponible" → el operador NO puede desembolsar;
    // NUNCA un silencio que finja que la plata salió.
    this.logger.error(
      `[YAPE-PLIN-PAYOUT] desembolso LIVE no disponible (convenio PSP pendiente) payout=${req.payoutId}`,
    );
    throw new ExternalServiceError(
      'payout live no disponible: convenio PSP pendiente (YapePlinPayoutGateway diferido · ADR-015 D2)',
    );
  }
}
