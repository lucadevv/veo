import { describe, it, expect, vi } from 'vitest';
import { registerUser } from './user-registration';
import type { Prisma } from '../generated/prisma';

/**
 * Spec del registro transaccional ÚNICO (Lote A2): la función que reemplazó las 4 copias del
 * bloque create User + create AuthMethod + outbox user.registered (phone, email, Google, Apple).
 * Acá se fija el CONTRATO del evento (eventType, producer, payload) en un solo lugar.
 */
interface OutboxCall {
  data: {
    aggregateId: string;
    eventType: string;
    envelope: {
      eventId: string;
      eventType: string;
      occurredAt: string;
      producer: string;
      schemaVersion: number;
      payload: Record<string, unknown>;
    };
  };
}

function makeTx(userRow: { id: string; phone: string | null; kycStatus: string }) {
  const calls: string[] = [];
  const tx = {
    user: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('user.create');
        return { ...data, ...userRow };
      }),
    },
    authMethod: {
      create: vi.fn(async () => {
        calls.push('authMethod.create');
        return {};
      }),
    },
    outboxEvent: {
      create: vi.fn(async () => {
        calls.push('outboxEvent.create');
        return {};
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, mocks: tx, calls };
}

describe('registerUser (registro transaccional único)', () => {
  it('crea User + AuthMethod + outbox user.registered sobre el MISMO tx, en ese orden', async () => {
    const { tx, mocks, calls } = makeTx({ id: 'u-1', phone: '+51987654321', kycStatus: 'PENDING' });

    const user = await registerUser(tx, {
      user: { phone: '+51987654321', type: 'PASSENGER' },
      authMethod: { type: 'PHONE_OTP', verified: true },
    });

    expect(user.id).toBe('u-1');
    expect(calls).toEqual(['user.create', 'authMethod.create', 'outboxEvent.create']);
    expect(mocks.user.create).toHaveBeenCalledWith({
      data: { phone: '+51987654321', type: 'PASSENGER' },
    });
    // La credencial cuelga del User recién creado (userId lo asigna la función).
    expect(mocks.authMethod.create).toHaveBeenCalledWith({
      data: { userId: 'u-1', type: 'PHONE_OTP', verified: true },
    });
  });

  it('emite user.registered con el envelope canónico (@veo/events) y aggregateId = userId', async () => {
    const { tx, mocks } = makeTx({ id: 'u-7', phone: '+51911111111', kycStatus: 'PENDING' });

    await registerUser(tx, {
      user: { phone: '+51911111111', type: 'DRIVER' },
      authMethod: { type: 'PHONE_OTP', verified: true },
    });

    expect(mocks.outboxEvent.create).toHaveBeenCalledOnce();
    const calls = mocks.outboxEvent.create.mock.calls as unknown as [OutboxCall][];
    const { data } = calls[0]![0];
    expect(data.aggregateId).toBe('u-7');
    expect(data.eventType).toBe('user.registered');
    const env = data.envelope;
    expect(env.eventType).toBe('user.registered');
    expect(env.producer).toBe('identity-service');
    expect(env.schemaVersion).toBe(1);
    expect(env.eventId).toEqual(expect.any(String));
    expect(env.occurredAt).toEqual(expect.any(String));
    // Payload canónico (schema userRegistered de @veo/events): única fuente del contrato.
    expect(env.payload).toEqual({ userId: 'u-7', phone: '+51911111111', kycStatus: 'PENDING' });
  });

  it('usuario sin teléfono (alta por email/OAuth) → payload con phone = "" (contrato del schema)', async () => {
    const { tx, mocks } = makeTx({ id: 'u-9', phone: null, kycStatus: 'PENDING' });

    await registerUser(tx, {
      user: { email: 'ada@veo.pe', name: 'Ada', type: 'PASSENGER' },
      authMethod: {
        type: 'GOOGLE_OAUTH',
        oauthSubject: 'g-sub-1',
        email: 'ada@veo.pe',
        emailVerified: true,
        verified: true,
      },
    });

    const calls = mocks.outboxEvent.create.mock.calls as unknown as [OutboxCall][];
    expect(calls[0]![0].data.envelope.payload).toEqual({
      userId: 'u-9',
      phone: '',
      kycStatus: 'PENDING',
    });
  });

  it('si el outbox falla, propaga el error (el caller aborta la tx: o todo o nada)', async () => {
    const { tx, mocks } = makeTx({ id: 'u-2', phone: null, kycStatus: 'PENDING' });
    mocks.outboxEvent.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      registerUser(tx, {
        user: { email: 'eve@veo.pe', type: 'PASSENGER' },
        authMethod: { type: 'EMAIL_PASSWORD', email: 'eve@veo.pe', verified: false },
      }),
    ).rejects.toThrow('db down');
  });
});
