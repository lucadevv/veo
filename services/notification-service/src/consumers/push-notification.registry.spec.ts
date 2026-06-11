/**
 * Registry declarativo de pushes · dos frentes:
 *
 *  1) MOTOR (`runPushSpec`) con una fila SINTÉTICA: valida el esqueleto común (parse → gate →
 *     resolver destinos → warn-si-vacío → enqueue idempotente por device) una sola vez, para
 *     todas las filas presentes y futuras.
 *  2) CONTRATO de cada fila: el schema es EL MISMO objeto registrado en @veo/events (identidad,
 *     no copia — caza re-declaraciones), la key del registro coincide con el eventType, el
 *     template estático existe en el catálogo como PUSH, y los handlers dedicados no se solapan
 *     con el registro. Caza el drift en test-time, antes de llegar a Kafka.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createEnvelope, EVENT_SCHEMAS, type EventEnvelope } from '@veo/events';
import { NotificationChannel } from '@veo/shared-types';
import { NotificationPriority, type EnqueueInput } from '../engine/types';
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS } from '../engine/template.catalog';
import type { DeviceTarget } from '../devices/device-token.repository';
import {
  PUSH_NOTIFICATION_SPECS,
  defineSpec,
  runPushSpec,
  type PushSpecContext,
} from './push-notification.registry';
import { DEDICATED_EVENT_TYPES } from './event-consumer.service';

/* ────────────────────────────── 1 · el motor, con una fila sintética ────────────────────────────── */

const PAX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Fila sintética sobre un contrato real del registro central (trip.started: schema simple). */
function syntheticSpec(overrides: Partial<Parameters<typeof defineSpec<'trip.started', z.ZodTypeAny>>[1]> = {}) {
  return defineSpec('trip.started', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_STARTED,
    dedup: (p) => `trip:${p.tripId}:started`,
    data: (p) => ({ tripId: p.tripId }),
    ...overrides,
  });
}

function startedEnvelope(payload: Record<string, unknown>): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'trip.started',
    producer: 'test',
    payload: { tripId: 'trip-1', driverId: 'drv-1', startedAt: '2026-06-11T00:00:00Z', passengerId: PAX, ...payload },
  });
}

/** Contexto doble: captura enqueues/warns y resuelve targets desde un mapa en memoria. */
function fakeCtx(targetsByUser: Record<string, DeviceTarget[]>) {
  const enqueued: EnqueueInput[] = [];
  const warns: string[] = [];
  const resolveTargets = vi.fn(
    async (_eventType: string, userId: string | undefined, token?: string, platform?: 'android' | 'ios') => {
      if (token) return [{ token, platform: platform ?? 'android' }];
      if (!userId) return [];
      return targetsByUser[userId] ?? [];
    },
  );
  const ctx: PushSpecContext = {
    resolveTargets,
    enqueue: async (input) => {
      enqueued.push(input);
    },
    warn: (message) => {
      warns.push(message);
    },
  };
  return { ctx, enqueued, warns, resolveTargets };
}

describe('runPushSpec · esqueleto común del registro', () => {
  it('camino feliz: UN enqueue PUSH por device, dedupKey = `<segmento>:push:<token>`', async () => {
    const { ctx, enqueued, warns } = fakeCtx({
      [PAX]: [
        { token: 'tok-1', platform: 'android' },
        { token: 'tok-2', platform: 'ios' },
      ],
    });
    await runPushSpec(ctx, syntheticSpec(), startedEnvelope({}));

    expect(warns).toHaveLength(0);
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((e) => e.dedupKey)).toEqual(['trip:trip-1:started:push:tok-1', 'trip:trip-1:started:push:tok-2']);
    const first = enqueued[0]!;
    expect(first.recipientId).toBe(PAX);
    expect(first.channel).toBe(NotificationChannel.PUSH);
    expect(first.template).toBe(TEMPLATE_KEYS.TRIP_STARTED);
    expect(first.payload).toMatchObject({ to: 'tok-1', platform: 'android', vars: {}, data: { tripId: 'trip-1' } });
  });

  it('payload que no cumple el contrato del registro central → descarta sin warn ni enqueue', async () => {
    const { ctx, enqueued, warns } = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    await runPushSpec(
      ctx,
      syntheticSpec(),
      createEnvelope({ eventType: 'trip.started', producer: 'test', payload: { tripId: 'trip-1' } }),
    );
    expect(enqueued).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('gate de producto `when=false` → ignora sin warn (decisión deliberada, no gap)', async () => {
    const { ctx, enqueued, warns, resolveTargets } = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    await runPushSpec(ctx, syntheticSpec({ when: () => false }), startedEnvelope({}));
    expect(enqueued).toHaveLength(0);
    expect(warns).toHaveLength(0);
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it('sin token del destinatario (evento ni almacén) → warn y omite (degradación honesta)', async () => {
    const { ctx, enqueued, warns } = fakeCtx({});
    await runPushSpec(ctx, syntheticSpec(), startedEnvelope({}));
    expect(enqueued).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('trip.started');
  });

  it('hint de transporte: el token enriquecido del evento viaja a resolveTargets y gana', async () => {
    const { ctx, enqueued, resolveTargets } = fakeCtx({});
    await runPushSpec(ctx, syntheticSpec(), startedEnvelope({ passengerPushToken: 'tok-EVENT', platform: 'ios' }));
    expect(resolveTargets).toHaveBeenCalledWith('trip.started', PAX, 'tok-EVENT', 'ios');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload.to).toBe('tok-EVENT');
  });

  it('recipientFallback: sin userId pero con token enriquecido, registra con el fallback histórico', async () => {
    const { ctx, enqueued } = fakeCtx({});
    const spec = syntheticSpec({ recipient: () => undefined, recipientFallback: (p) => p.tripId as string });
    await runPushSpec(ctx, spec, startedEnvelope({ passengerPushToken: 'tok-EVENT' }));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientId).toBe('trip-1');
  });

  it('sin userId, sin fallback → warn y omite (no inventa recipientId)', async () => {
    const { ctx, enqueued, warns } = fakeCtx({});
    const spec = syntheticSpec({ recipient: () => undefined });
    await runPushSpec(ctx, spec, startedEnvelope({ passengerPushToken: 'tok-EVENT' }));
    expect(enqueued).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  it('priority declarada en la fila viaja al enqueue; ausente → no se inyecta (default del engine)', async () => {
    const withPriority = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    await runPushSpec(
      withPriority.ctx,
      syntheticSpec({ priority: NotificationPriority.Critical }),
      startedEnvelope({}),
    );
    expect(withPriority.enqueued[0]!.priority).toBe(NotificationPriority.Critical);

    const without = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    await runPushSpec(without.ctx, syntheticSpec(), startedEnvelope({}));
    expect('priority' in without.enqueued[0]!).toBe(false);
  });

  it('template dinámico (función del payload) se resuelve por evento', async () => {
    const { ctx, enqueued } = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    const spec = syntheticSpec({
      template: (p) => (p.passengerId ? TEMPLATE_KEYS.TRIP_STARTED : TEMPLATE_KEYS.TRIP_EXPIRED),
    });
    await runPushSpec(ctx, spec, startedEnvelope({}));
    expect(enqueued[0]!.template).toBe(TEMPLATE_KEYS.TRIP_STARTED);
  });

  it('enrichment con drift de tipos (campo enriquecido malformado) → descarta el evento', async () => {
    const { ctx, enqueued } = fakeCtx({ [PAX]: [{ token: 'tok-1', platform: 'android' }] });
    const spec = syntheticSpec({ enrichment: z.object({ driverName: z.string().optional() }) });
    await runPushSpec(ctx, spec, startedEnvelope({ driverName: 42 }));
    expect(enqueued).toHaveLength(0);
  });
});

/* ────────────────────────────── 2 · contrato de cada fila del registro ────────────────────────────── */

/** Keys de plantilla PUSH sembradas en el catálogo (las únicas válidas para una fila del registro). */
const PUSH_TEMPLATE_KEYS = new Set(
  DEFAULT_TEMPLATES.filter((t) => t.channel === NotificationChannel.PUSH).map((t) => t.key),
);

describe('PUSH_NOTIFICATION_SPECS · contrato (caza el drift en test-time)', () => {
  const rows = Object.entries(PUSH_NOTIFICATION_SPECS);

  it('hay filas en el registro (el consumer deriva sus .on() de acá)', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows)('%s · el schema es EXACTAMENTE el registrado en @veo/events (identidad, no copia)', (key, spec) => {
    expect(spec.eventType).toBe(key); // la key del Record y la fila no divergen
    expect(EVENT_SCHEMAS[spec.eventType]).toBeDefined();
    expect(spec.schema).toBe(EVENT_SCHEMAS[spec.eventType]); // misma referencia: imposible re-declarar
  });

  it.each(rows)('%s · el template estático existe en el catálogo como PUSH', (_key, spec) => {
    if (typeof spec.template === 'function') return; // dinámicos: cubiertos por el chequeo del catálogo completo
    expect(PUSH_TEMPLATE_KEYS.has(spec.template)).toBe(true);
  });

  it('todas las TEMPLATE_KEYS tienen seed en el catálogo (cubre también los templates dinámicos)', () => {
    const seeded = new Set(DEFAULT_TEMPLATES.map((t) => t.key));
    for (const key of Object.values(TEMPLATE_KEYS)) {
      expect(seeded.has(key), `template ${key} sin seed en DEFAULT_TEMPLATES`).toBe(true);
    }
  });

  it('los handlers dedicados NO se solapan con el registro (un evento, un dueño)', () => {
    const registryKeys = new Set(Object.keys(PUSH_NOTIFICATION_SPECS));
    for (const dedicated of DEDICATED_EVENT_TYPES) {
      expect(registryKeys.has(dedicated), `${dedicated} no puede estar en registro Y dedicado`).toBe(false);
    }
  });
});
