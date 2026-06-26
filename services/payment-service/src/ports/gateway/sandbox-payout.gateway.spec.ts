import { describe, it, expect } from 'vitest';
import { PayoutPermanentlyRejectedError } from '@veo/utils';
import { SandboxPayoutGateway } from './sandbox-payout.gateway';
import type { DisburseRequest } from './payout-gateway.port';

function gw(opts?: ConstructorParameters<typeof SandboxPayoutGateway>[0]) {
  return new SandboxPayoutGateway(opts);
}

function req(over?: Partial<DisburseRequest>): DisburseRequest {
  return {
    payoutId: 'po-1',
    driverId: 'drv-1',
    amountCents: 5000, // S/50 — no múltiplo de 13 → no se rechaza por monto
    method: 'YAPE',
    currency: 'PEN',
    ...over,
  };
}

describe('SandboxPayoutGateway · disburse (determinista)', () => {
  it('SUBMITTED por default (async): la confirmación llega luego por webhook/poll', async () => {
    const r = await gw().disburse(req());
    expect(r.status).toBe('SUBMITTED');
    expect(r.externalRef).toContain('po-1');
  });

  it('externalRef es DETERMINISTA por payoutId (idempotencia: re-disparar no genera otro ref)', async () => {
    const first = await gw().disburse(req());
    const second = await gw().disburse(req());
    expect(second.externalRef).toBe(first.externalRef);
    expect(first.externalRef).toContain('yape');
  });

  it('CONFIRMED síncrono cuando confirmSync=true (la plata salió en línea)', async () => {
    const r = await gw({ confirmSync: true }).disburse(req());
    expect(r.status).toBe('CONFIRMED');
    expect(r.externalRef).toContain('po-1');
  });

  it('RECHAZO permanente determinista si amountCents es múltiplo del rejectSeed (camino FAILED)', async () => {
    // 13 * 100 = 1300 → múltiplo del seed default 13 → rechazo permanente.
    await expect(gw().disburse(req({ amountCents: 1300 }))).rejects.toBeInstanceOf(
      PayoutPermanentlyRejectedError,
    );
  });

  it('el rechazo permanente NO es transitorio: lleva payoutId+amount en details', async () => {
    try {
      await gw().disburse(req({ payoutId: 'po-9', amountCents: 26 }));
      expect.unreachable('debió rechazar permanente');
    } catch (err) {
      expect(err).toBeInstanceOf(PayoutPermanentlyRejectedError);
      const e = err as PayoutPermanentlyRejectedError;
      expect(e.details).toMatchObject({ payoutId: 'po-9', amountCents: 26 });
    }
  });

  it('rejectSeed=0 desactiva el rechazo por monto (cualquier monto pasa a SUBMITTED)', async () => {
    const r = await gw({ rejectSeed: 0 }).disburse(req({ amountCents: 13 }));
    expect(r.status).toBe('SUBMITTED');
  });
});
