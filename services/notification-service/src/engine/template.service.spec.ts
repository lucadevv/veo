import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { interpolate, TemplateService } from './template.service';
import { categoryForTemplate } from './template.catalog';
import type { NotificationRecord } from './types';

describe('interpolate', () => {
  it('reemplaza placeholders {{var}}', () => {
    expect(interpolate('Hola {{name}}, ETA {{eta}} min', { name: 'Ana', eta: 5 })).toBe(
      'Hola Ana, ETA 5 min',
    );
  });

  it('tolera espacios dentro de las llaves', () => {
    expect(interpolate('{{ a }}-{{b}}', { a: 1, b: 2 })).toBe('1-2');
  });

  it('variables ausentes → cadena vacía', () => {
    expect(interpolate('x={{missing}}', {})).toBe('x=');
  });
});

/** TemplateService.renderInbox NO toca el repo → se instancia con stubs para probar la lógica pura. */
function makeService(): TemplateService {
  const repo = {} as never;
  const config = { getOrThrow: () => 'es-PE' } as unknown as ConfigService<never, true>;
  return new TemplateService(repo, config);
}

function rec(partial: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'n1',
    recipientId: 'u1',
    channel: 'PUSH',
    template: 'trip.accepted',
    payload: {},
    status: 'PENDING',
    priority: 0,
    dedupKey: null,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    sentAt: null,
    deliveredAt: null,
    failedReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('TemplateService.renderInbox · bandeja in-app (NO exige payload.to, resiliente)', () => {
  const svc = makeService();
  const tpl = {
    subject: 'Tu conductor confirmo',
    body: '{{driverName}} confirmo tu viaje y va en camino. Llega en {{etaMinutes}} min.',
  };

  it('renderiza título y cuerpo SIN requerir payload.to (la diferencia clave con render())', () => {
    const out = svc.renderInbox(rec({ payload: { driverName: 'Ana', etaMinutes: 5 } }), tpl);
    expect(out.title).toBe('Tu conductor confirmo');
    expect(out.body).toBe('Ana confirmo tu viaje y va en camino. Llega en 5 min.');
  });

  it('toma las variables de payload.vars si existe (misma convención que render())', () => {
    const out = svc.renderInbox(
      rec({ payload: { vars: { driverName: 'Beto', etaMinutes: 3 }, to: 'push-token' } }),
      tpl,
    );
    expect(out.body).toBe('Beto confirmo tu viaje y va en camino. Llega en 3 min.');
  });

  it('plantilla faltante (key huérfana) → fallback honesto, NO lanza', () => {
    const out = svc.renderInbox(rec({ template: 'unknown.key' }), undefined);
    expect(out).toEqual({ title: 'VEO', body: 'Tienes una notificación nueva.' });
  });
});

describe('categoryForTemplate · familia de la key → categoría pública (no filtra la key interna)', () => {
  it.each([
    ['trip.accepted', 'trip'],
    ['chat.message', 'trip'],
    ['panic.contact_alert', 'safety'],
    ['contact.otp', 'safety'],
    ['payment.cash_pending', 'payment'],
    ['promo.weekend', 'promo'],
    ['something.else', 'general'],
  ])('%s → %s', (key, expected) => {
    expect(categoryForTemplate(key)).toBe(expected);
  });
});
