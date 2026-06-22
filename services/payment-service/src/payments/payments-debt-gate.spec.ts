/**
 * Spec del gate de DEUDA de DOBLE PROPÓSITO (GET /payments/debt · ADR-014 §5.5 · F3a).
 *
 * El endpoint resuelve QUÉ passengerId consultar según el RIEL emisor — invariante de SEGURIDAD que esta
 * suite vuelve ejecutable:
 *  - service-rail (SISTEMA · booking on-behalf-of): el passengerId sale del QUERY (la identidad de sistema
 *    es anónima, userId='anonymous' → no viaja en la identidad). Sin query → ForbiddenError (NUNCA se cae a
 *    'anonymous': eso re-abriría el gate-NULO que F3a cerró).
 *  - cliente (public/driver/admin): el passengerId sale SIEMPRE de la identidad firmada (CurrentUser); el
 *    query se IGNORA (anti-IDOR: un pasajero no puede espiar la deuda de otro pasándolo a mano).
 *
 * Ejercitamos el handler REAL `PaymentsController.debt` con un PaymentsService MOCK que captura el
 * passengerId con el que se consultó la deuda — así verificamos la rama de resolución de extremo a extremo
 * de la lógica del controller, sin levantar Nest ni la DB.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import { PaymentsController } from './payments.controller';
import type { PaymentsService } from './payments.service';
import type { DebtQueryDto, DebtSummary } from './dto/payments.dto';

const SIGNED_PASSENGER = '00000000-0000-0000-0000-0000000000aa';
const QUERY_PASSENGER = '00000000-0000-0000-0000-0000000000bb';

const EMPTY_SUMMARY: DebtSummary = { hasDebt: false, debts: [], totalCents: 0 };

/** Controller con un PaymentsService mock que registra el passengerId consultado. */
function makeController() {
  const getDebtForPassenger = vi.fn(async (_id: string): Promise<DebtSummary> => EMPTY_SUMMARY);
  const service = { getDebtForPassenger } as unknown as PaymentsService;
  return { controller: new PaymentsController(service), getDebtForPassenger };
}

function userWith(userId: string): AuthenticatedUser {
  return { userId, type: 'passenger', roles: [], sessionId: 's' };
}

function query(passengerId?: string): DebtQueryDto {
  return passengerId ? { passengerId } : {};
}

describe('GET /payments/debt · resolución de passengerId por riel (doble propósito)', () => {
  it('service-rail CON ?passengerId=X → consulta la deuda de X (on-behalf-of de booking)', async () => {
    const { controller, getDebtForPassenger } = makeController();

    // El usuario firmado es ANÓNIMO (lo que firma booking), pero el query trae el pasajero real.
    await controller.debt(
      userWith('anonymous'),
      InternalAudience.SERVICE_RAIL,
      query(QUERY_PASSENGER),
    );

    // CIERRA EL BUG: se consulta el pasajero REAL del query, NO 'anonymous'.
    expect(getDebtForPassenger).toHaveBeenCalledWith(QUERY_PASSENGER);
    expect(getDebtForPassenger).not.toHaveBeenCalledWith('anonymous');
  });

  it('service-rail SIN query → ForbiddenError (no cae en silencio a anonymous)', () => {
    const { controller, getDebtForPassenger } = makeController();

    // La resolución del riel rechaza ANTES de tocar el service: el throw es síncrono (no una promesa).
    expect(() =>
      controller.debt(userWith('anonymous'), InternalAudience.SERVICE_RAIL, query()),
    ).toThrow(ForbiddenError);
    // Y JAMÁS consultó la deuda (ni de anonymous ni de nadie): el gate no se evalúa con identidad falsa.
    expect(getDebtForPassenger).not.toHaveBeenCalled();
  });

  it('riel de CLIENTE (public): usa el pasajero FIRMADO e IGNORA el query (anti-IDOR)', async () => {
    const { controller, getDebtForPassenger } = makeController();

    // Un cliente intenta espiar la deuda de OTRO pasajero pasándolo por query: debe ser ignorado.
    await controller.debt(
      userWith(SIGNED_PASSENGER),
      InternalAudience.PUBLIC_RAIL,
      query(QUERY_PASSENGER),
    );

    expect(getDebtForPassenger).toHaveBeenCalledWith(SIGNED_PASSENGER);
    expect(getDebtForPassenger).not.toHaveBeenCalledWith(QUERY_PASSENGER);
  });

  it('riel de CLIENTE (driver): mismo anti-IDOR — identidad firmada, query ignorado', async () => {
    const { controller, getDebtForPassenger } = makeController();

    await controller.debt(
      userWith(SIGNED_PASSENGER),
      InternalAudience.DRIVER_RAIL,
      query(QUERY_PASSENGER),
    );

    expect(getDebtForPassenger).toHaveBeenCalledWith(SIGNED_PASSENGER);
  });
});
