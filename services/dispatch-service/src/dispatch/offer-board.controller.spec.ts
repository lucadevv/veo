/**
 * Trust-boundary del lado conductor (cierre #9): los routes DRIVER derivan el driverId de la
 * identidad FIRMADA (@CurrentUser().driverId), NUNCA del cliente. Un cliente que nombra otro driverId
 * en el body/query NO puede ofertar/listar suplantando a ese conductor; una identidad sin driverId
 * (passenger/admin) no es conductor → 403.
 */
import { describe, it, expect, vi } from 'vitest';
import { isDomainError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { OfferBoardController } from './offer-board.controller';
import type { OfferBoardService } from './offer-board.service';
import type { Offer, OfferBoard } from './offer-board.port';
import { VehicleType } from '@veo/shared-types';
import type { SubmitOfferDto } from './dto/offer-board.dto';

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
    originCell: '8abc',
    status: 'OPEN',
    expiresAt: Date.now() + 60_000,
    negotiationSeq: 1,
    specialRequests: [],
  };
  const svc = {
    submitOffer: vi.fn(async () => offer),
    listOpenBidsNear: vi.fn(async () => [board]),
    getOffersView: vi.fn(async () => ({
      board: { status: 'OPEN' as const, expiresAt: board.expiresAt },
      offers: [offer],
    })),
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
    const { ctrl } = makeController();
    const res = await ctrl.listOffers(TRIP);
    expect(res.board.status).toBe('OPEN');
    expect(typeof res.board.expiresAt).toBe('number');
    expect(res.offers).toHaveLength(1);
    expect(res.offers[0]?.driverId).toBe('signed-driver');
  });

  it('FIX cancel-puja · cancel del pasajero llama cancelBoard con emitClosure=true (cierra el VIAJE)', async () => {
    const { ctrl, svc } = makeController();
    const res = await ctrl.cancel(TRIP);
    expect(res).toEqual({ ok: true });
    expect(svc.cancelBoard).toHaveBeenCalledWith(TRIP, { emitClosure: true });
  });
});
