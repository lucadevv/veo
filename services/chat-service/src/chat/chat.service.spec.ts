import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '@veo/utils';
import { ChatService } from './chat.service';
import type { ChatRepository } from './chat.repository';
import type { Env } from '../config/env.schema';

function makeConfig(): ConfigService<Env, true> {
  return new ConfigService<Env, true>({
    CHAT_MAX_BODY_LENGTH: 20,
    CHAT_MAX_PAGE_SIZE: 50,
  });
}

/** Construye un ChatRepository falso cuyo runInTx ejecuta el callback con un tx mockeado. */
function makeRepoWithTx(messageRow: Record<string, unknown>): {
  repo: ChatRepository;
  create: ReturnType<typeof vi.fn>;
  outboxCreate: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(messageRow);
  const outboxCreate = vi.fn().mockResolvedValue({});
  const tx = { message: { create }, outboxEvent: { create: outboxCreate } };
  const repo = {
    runInTx: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as ChatRepository;
  return { repo, create, outboxCreate };
}

describe('ChatService.postMessage (validación de cuerpo)', () => {
  it('rechaza mensaje vacío (solo espacios)', async () => {
    const { repo } = makeRepoWithTx({});
    const svc = new ChatService(repo, makeConfig());
    await expect(
      svc.postMessage({ tripId: 't', senderId: 's', senderRole: 'PASSENGER', body: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza mensaje sobre el límite', async () => {
    const { repo } = makeRepoWithTx({});
    const svc = new ChatService(repo, makeConfig());
    await expect(
      svc.postMessage({ tripId: 't', senderId: 's', senderRole: 'DRIVER', body: 'x'.repeat(21) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('persiste, encola el evento y devuelve la vista con body recortado', async () => {
    const createdAt = new Date('2026-05-30T12:00:00.000Z');
    const { repo, create, outboxCreate } = makeRepoWithTx({
      id: 'm1',
      tripId: 't1',
      senderId: 's1',
      senderRole: 'PASSENGER',
      body: 'hola',
      createdAt,
    });
    const svc = new ChatService(repo, makeConfig());

    const view = await svc.postMessage({
      tripId: 't1',
      senderId: 's1',
      senderRole: 'PASSENGER',
      body: '  hola  ',
    });

    expect(create).toHaveBeenCalledOnce();
    const createArg = create.mock.calls[0]?.[0] as { data: { body: string } };
    expect(createArg.data.body).toBe('hola'); // trim aplicado antes de persistir
    expect(outboxCreate).toHaveBeenCalledOnce(); // evento chat.message_sent encolado en la misma tx
    expect(view).toEqual({
      id: 'm1',
      tripId: 't1',
      senderId: 's1',
      senderRole: 'PASSENGER',
      body: 'hola',
      createdAt: createdAt.toISOString(),
    });
  });
});

describe('ChatService.listMessages (paginación)', () => {
  it('topa el limit al máximo de página', async () => {
    const findByTrip = vi.fn().mockResolvedValue([]);
    const repo = { findByTrip } as unknown as ChatRepository;
    const svc = new ChatService(repo, makeConfig());
    await svc.listMessages('t1', 9999);
    const take = findByTrip.mock.calls[0]?.[1] as number;
    expect(take).toBe(50); // CHAT_MAX_PAGE_SIZE
  });
});
