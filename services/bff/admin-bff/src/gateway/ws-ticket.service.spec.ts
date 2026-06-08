import { describe, it, expect } from 'vitest';
import { WsTicketService } from './ws-ticket.service';
import type Redis from 'ioredis';
import type { AuthenticatedUser } from '@veo/auth';

/**
 * Redis falso en memoria: implementa solo SET con EX y GETDEL (consumo atómico) que usa el servicio.
 * No simula expiración por tiempo; la caducidad real la cubre Redis. Aquí verificamos el consumo único.
 */
class FakeRedis {
  private readonly store = new Map<string, string>();

  async set(key: string, value: string, _mode: 'EX', _seconds: number): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
}

const user: AuthenticatedUser = {
  userId: 'admin-1',
  type: 'admin',
  roles: ['ADMIN', 'SUPERADMIN'],
  sessionId: 'sess-1',
  mfaVerifiedAt: 1700000000,
};

function makeService(): WsTicketService {
  return new WsTicketService(new FakeRedis() as unknown as Redis);
}

describe('WsTicketService', () => {
  it('acuña un ticket con expiración futura y un valor no vacío', async () => {
    const before = Date.now();
    const { ticket, expiresAt } = await makeService().mint(user);
    expect(ticket.length).toBeGreaterThan(20);
    expect(Date.parse(expiresAt)).toBeGreaterThan(before);
  });

  it('consume el ticket una sola vez (el segundo uso falla)', async () => {
    const service = makeService();
    const { ticket } = await service.mint(user);

    const first = await service.consume(ticket);
    expect(first).toEqual({
      userId: 'admin-1',
      type: 'admin',
      roles: ['ADMIN', 'SUPERADMIN'],
      sessionId: 'sess-1',
      mfaAt: 1700000000,
    });

    const second = await service.consume(ticket);
    expect(second).toBeNull();
  });

  it('devuelve null ante un ticket inexistente/expirado', async () => {
    const service = makeService();
    expect(await service.consume('no-existe')).toBeNull();
    expect(await service.consume('')).toBeNull();
  });

  it('genera tickets distintos en cada minteo', async () => {
    const service = makeService();
    const a = await service.mint(user);
    const b = await service.mint(user);
    expect(a.ticket).not.toEqual(b.ticket);
  });
});
