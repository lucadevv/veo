import { describe, it, expect } from 'vitest';
import { SupportService } from './support.service';
import type { SupportTicketRepository, CreateTicketInput } from './support.repository';
import type { SupportTicket } from '../generated/prisma';

function makeTicket(input: CreateTicketInput, id: string): SupportTicket {
  return {
    id,
    userId: input.userId,
    role: input.role,
    category: input.category,
    subject: input.subject,
    body: input.body,
    status: 'OPEN',
    tripId: input.tripId ?? null,
    createdAt: new Date('2026-05-30T12:00:00Z'),
    updatedAt: new Date('2026-05-30T12:00:00Z'),
  };
}

function makeService() {
  const store: SupportTicket[] = [];
  const repo: Pick<SupportTicketRepository, 'create' | 'findByUser'> = {
    create: async (input) => {
      const t = makeTicket(input, `t-${store.length + 1}`);
      store.push(t);
      return t;
    },
    findByUser: async (userId) =>
      store.filter((t) => t.userId === userId).sort((a, b) => b.id.localeCompare(a.id)),
  };
  return new SupportService(repo as SupportTicketRepository);
}

describe('SupportService', () => {
  it('crea un ticket OPEN y lo mapea a la vista (fecha ISO, tripId nullable)', async () => {
    const service = makeService();
    const view = await service.create({
      userId: '00000000-0000-7000-8000-000000000001',
      role: 'PASSENGER',
      category: 'PAYMENT',
      subject: 'No me llegó el recibo',
      body: 'Pagué con Yape pero no veo el recibo.',
    });
    expect(view.status).toBe('OPEN');
    expect(view.role).toBe('PASSENGER');
    expect(view.tripId).toBeNull();
    expect(view.createdAt).toBe('2026-05-30T12:00:00.000Z');
  });

  it('lista solo los tickets del usuario', async () => {
    const service = makeService();
    await service.create({ userId: 'u1', role: 'DRIVER', category: 'TRIP', subject: 'aaa', body: 'x', tripId: undefined });
    await service.create({ userId: 'u2', role: 'PASSENGER', category: 'OTHER', subject: 'bbb', body: 'y' });
    const mine = await service.listByUser('u1');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.category).toBe('TRIP');
  });
});
