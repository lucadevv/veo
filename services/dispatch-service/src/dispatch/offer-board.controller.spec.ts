/**
 * Trust-boundary del lado conductor (cierre #9): los routes DRIVER derivan el driverId de la
 * identidad FIRMADA (@CurrentUser().driverId), NUNCA del cliente. Un cliente que nombra otro driverId
 * en el body/query NO puede ofertar/listar suplantando a ese conductor; una identidad sin driverId
 * (passenger/admin) no es conductor → 403.
 */
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { isDomainError } from '@veo/utils';
import { AudienceGuard, InternalAudience, type AuthenticatedUser } from '@veo/auth';
import { OfferBoardController } from './offer-board.controller';
import type { OfferBoardService } from './offer-board.service';
import type { Offer, OfferBoard } from './offer-board.port';
import { VehicleType } from '@veo/shared-types';
import type { AcceptOfferDto, SubmitOfferDto } from './dto/offer-board.dto';

const TRIP = '00000000-0000-0000-0000-000000000001';
const ORIGIN = { lat: -12.0464, lon: -77.0428 };

function driverUser(driverId?: string): AuthenticatedUser {
  return {
    userId: 'user-1',
    type: 'driver',
    roles: [],
    sessionId: 'sess-1',
    driverId,
  };
}

function passengerUser(): AuthenticatedUser {
  return { userId: 'user-2', type: 'passenger', roles: [], sessionId: 'sess-2' };
}

function makeController(): {
  ctrl: OfferBoardController;
  svc: {
    submitOffer: ReturnType<typeof vi.fn>;
    listOpenBidsNear: ReturnType<typeof vi.fn>;
    getOffersView: ReturnType<typeof vi.fn>;
    acceptOffer: ReturnType<typeof vi.fn>;
    cancelBoard: ReturnType<typeof vi.fn>;
  };
} {
  const offer: Offer = {
    tripId: TRIP,
    driverId: 'signed-driver',
    kind: 'ACCEPT_PRICE',
    priceCents: 700,
    etaSeconds: 120,
    status: 'PENDING',
    updatedAt: Date.now(),
  };
  const board: OfferBoard = {
    tripId: TRIP,
    passengerId: 'p1',
    bidCents: 700,
    vehicleType: VehicleType.CAR,
    origin: ORIGIN,
    destination: { lat: -12.0931, lon: -77.0465 },
    distanceMeters: 4200,
    durationSeconds: 900,
    originCell: '8abc',
    status: 'OPEN',
    expiresAt: Date.now() + 60_000,
    negotiationSeq: 1,
    specialRequests: [],
  };
  const svc = {
    submitOffer: vi.fn(async () => offer),
    // El service devuelve el par board + ETA per-conductor (enrich del poll).
    listOpenBidsNear: vi.fn(async () => [{ board, pickupEtaSeconds: 240 }]),
    getOffersView: vi.fn(async () => ({
      board: { status: 'OPEN' as const, expiresAt: board.expiresAt },
      offers: [offer],
    })),
    acceptOffer: vi.fn(async () => offer),
    cancelBoard: vi.fn(async () => undefined),
  };
  const ctrl = new OfferBoardController(svc as unknown as OfferBoardService);
  return { ctrl, svc };
}

const baseDto: SubmitOfferDto = { kind: 'ACCEPT_PRICE', priceCents: 700 };

describe('OfferBoardController — trust boundary del lado conductor (#9)', () => {
  it('submitOffer usa el driverId FIRMADO, no uno del cliente', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.submitOffer(TRIP, driverUser('signed-driver'), baseDto);
    expect(svc.submitOffer).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: 'signed-driver', tripId: TRIP }),
    );
  });

  it('submitOffer IGNORA un driverId colado en el body — oferta como el conductor FIRMADO', async () => {
    const { ctrl, svc } = makeController();
    // Un cliente malicioso intenta colar otro driverId en el body (campo ya removido del DTO).
    const spoofed = { ...baseDto, driverId: 'victim-driver' } as SubmitOfferDto & {
      driverId: string;
    };
    await ctrl.submitOffer(TRIP, driverUser('signed-driver'), spoofed);
    // El service recibe el FIRMADO, nunca 'victim-driver'.
    expect(svc.submitOffer).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: 'signed-driver' }),
    );
    const arg = svc.submitOffer.mock.calls[0]?.[0] as { driverId: string };
    expect(arg.driverId).not.toBe('victim-driver');
  });

  it('submitOffer con identidad SIN driverId (passenger) → 403, no llama al service', async () => {
    const { ctrl, svc } = makeController();
    let caught: unknown;
    try {
      await ctrl.submitOffer(TRIP, passengerUser(), baseDto);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
    expect(svc.submitOffer).not.toHaveBeenCalled();
  });

  it('listOpen usa el driverId FIRMADO', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.listOpen(driverUser('signed-driver'));
    expect(svc.listOpenBidsNear).toHaveBeenCalledWith('signed-driver');
  });

  it('listOpen expone los datos de DECISIÓN de la card: pickupEtaSeconds (per-conductor) + waypointCount', async () => {
    const { ctrl } = makeController();
    const [dto] = await ctrl.listOpen(driverUser('signed-driver'));
    expect(dto?.pickupEtaSeconds).toBe(240);
    // Board sin waypointCount persistido (N-2) → el derivador degrada a 0, nunca undefined.
    expect(dto?.waypointCount).toBe(0);
  });

  it('listOpen OMITE pickupEtaSeconds cuando el ETA no estuvo disponible (0) — la app degrada el stat', async () => {
    const { ctrl, svc } = makeController();
    const [{ board }] = (await svc.listOpenBidsNear()) as [{ board: OfferBoard }];
    svc.listOpenBidsNear.mockResolvedValueOnce([{ board, pickupEtaSeconds: 0 }]);
    const [dto] = await ctrl.listOpen(driverUser('signed-driver'));
    expect(dto && 'pickupEtaSeconds' in dto).toBe(false);
  });

  it('listOpen con identidad SIN driverId → 403, no llama al service', async () => {
    const { ctrl, svc } = makeController();
    let caught: unknown;
    try {
      await ctrl.listOpen(passengerUser());
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
    expect(svc.listOpenBidsNear).not.toHaveBeenCalled();
  });

  it('FIX contrato · listOffers devuelve { board:{status,expiresAt}, offers } (no un array pelado)', async () => {
    const { ctrl, svc } = makeController();
    const res = await ctrl.listOffers(TRIP, passengerUser());
    expect(res.board.status).toBe('OPEN');
    expect(typeof res.board.expiresAt).toBe('number');
    expect(res.offers).toHaveLength(1);
    expect(res.offers[0]?.driverId).toBe('signed-driver');
    // CAPA 2 — el passengerId (userId FIRMADO) se propaga al service para el guard de ownership.
    expect(svc.getOffersView).toHaveBeenCalledWith(TRIP, 'user-2');
  });

  it('CAPA 2 · accept pasa el passengerId FIRMADO al service y PRESERVA el driverId del body', async () => {
    const { ctrl, svc } = makeController();
    const dto: AcceptOfferDto = { driverId: 'chosen-driver' };
    await ctrl.accept(TRIP, dto, passengerUser());
    // (tripId, driverId-del-body, passengerId-FIRMADO): el pasajero elige conductor, el dueño se ancla.
    expect(svc.acceptOffer).toHaveBeenCalledWith(TRIP, 'chosen-driver', 'user-2');
  });

  it('FIX cancel-puja · cancel del pasajero llama cancelBoard con passengerId + emitClosure=true', async () => {
    const { ctrl, svc } = makeController();
    const res = await ctrl.cancel(TRIP, passengerUser());
    expect(res).toEqual({ ok: true });
    // CAPA 2 — ahora son 3 args: (tripId, passengerId-FIRMADO, opts).
    expect(svc.cancelBoard).toHaveBeenCalledWith(TRIP, 'user-2', { emitClosure: true });
  });
});

/**
 * CAPA 1 (frontera de transporte anti-confused-deputy): cada endpoint declara su RIEL aceptado vía
 * @Audiences. El AudienceGuard (corre tras InternalIdentityGuard, fail-closed) rechaza una identidad
 * de riel equivocado AUNQUE el HMAC sea válido. Verificamos el metadata real con un Reflector +
 * AudienceGuard reales (sin `any`): el del pasajero exige PUBLIC_RAIL, el del conductor DRIVER_RAIL.
 */
describe('OfferBoardController — frontera de audiencia por endpoint (CAPA 1)', () => {
  const reflector = new Reflector();
  const guard = new AudienceGuard(reflector);

  /** ExecutionContext mínimo apuntando a un handler real del controller, con un `aud` dado en req.user. */
  function ctxFor(method: keyof OfferBoardController, aud: InternalAudience): ExecutionContext {
    const handler = OfferBoardController.prototype[method] as (...args: unknown[]) => unknown;
    const req = { user: { aud } };
    return {
      getHandler: () => handler,
      getClass: () => OfferBoardController,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  const PASSENGER_ENDPOINTS = ['listOffers', 'accept', 'cancel'] as const;
  const DRIVER_ENDPOINTS = ['listOpen', 'submitOffer'] as const;

  it.each(PASSENGER_ENDPOINTS)('%s exige PUBLIC_RAIL (acepta public, rechaza driver)', (method) => {
    expect(guard.canActivate(ctxFor(method, InternalAudience.PUBLIC_RAIL))).toBe(true);
    let caught: unknown;
    try {
      guard.canActivate(ctxFor(method, InternalAudience.DRIVER_RAIL));
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
  });

  it.each(DRIVER_ENDPOINTS)('%s exige DRIVER_RAIL (acepta driver, rechaza public)', (method) => {
    expect(guard.canActivate(ctxFor(method, InternalAudience.DRIVER_RAIL))).toBe(true);
    let caught: unknown;
    try {
      guard.canActivate(ctxFor(method, InternalAudience.PUBLIC_RAIL));
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
  });
});
