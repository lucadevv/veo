import type { HttpClient } from '@veo/api-client';
import { HttpDebtRepository } from '../repositories/http-debt-repository';

type Handler = (method: string, path: string, opts: any) => unknown;

/** Doble de prueba del HttpClient (no es un mock de producción): registra llamadas y responde/lanza. */
class FakeHttpClient {
  calls: Array<{ method: string; path: string; opts: any }> = [];
  constructor(private readonly handler: Handler) {}
  // async: un throw del handler se convierte en promesa RECHAZADA (no un throw síncrono) — así el repo
  // propaga el error del BFF como rechazo, igual que el HttpClient real.
  async post(path: string, opts: any = {}) {
    this.calls.push({ method: 'POST', path, opts });
    return this.handler('POST', path, opts);
  }
  async get(path: string, opts: any = {}) {
    this.calls.push({ method: 'GET', path, opts });
    return this.handler('GET', path, opts);
  }
}

const asHttp = (h: FakeHttpClient): HttpClient => h as unknown as HttpClient;

const settlement = {
  id: 'pay-settle-1',
  tripId: 'trip-9',
  method: 'YAPE',
  status: 'PENDING',
  amountCents: 10000,
  grossCents: 10000,
  tipCents: 0,
  commissionCents: 0,
  feeCents: 0,
  externalRef: '',
  deepLink: 'yape://pay/abc',
};

describe('HttpDebtRepository', () => {
  it('settle pega a POST /earnings/debt/settle con el método (sin driverId en el body)', async () => {
    const fake = new FakeHttpClient(() => settlement);
    const repo = new HttpDebtRepository(asHttp(fake));

    const result = await repo.settle('YAPE', '999888777');

    expect(result).toMatchObject({ id: 'pay-settle-1', status: 'PENDING' });
    expect(fake.calls[0]?.path).toBe('/earnings/debt/settle');
    // El driverId NO viaja en el body (lo pone el BFF desde la identidad firmada): solo método + payerRef.
    expect(fake.calls[0]?.opts.body).toEqual({ method: 'YAPE', payerRef: '999888777' });
  });

  it('settle sin payerRef manda solo el método', async () => {
    const fake = new FakeHttpClient(() => settlement);
    const repo = new HttpDebtRepository(asHttp(fake));

    await repo.settle('PLIN');

    expect(fake.calls[0]?.opts.body).toEqual({ method: 'PLIN' });
  });

  it('propaga el error del BFF (409 sin deuda / 400 CASH) sin envolverlo', async () => {
    const boom = new Error('No tenés deuda de comisiones pendiente por saldar');
    const fake = new FakeHttpClient(() => {
      throw boom;
    });
    const repo = new HttpDebtRepository(asHttp(fake));

    await expect(repo.settle('CARD')).rejects.toBe(boom);
  });
});
