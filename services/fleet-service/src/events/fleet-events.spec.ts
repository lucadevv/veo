/**
 * Guard anti-drift del naming de eventos de fleet. El bug que cierra: fleet emitía `fleet.driver.suspended`
 * (dos puntos) pero el registro + los consumers (admin-bff) usan `fleet.driver_suspended` (guion bajo) →
 * admin-bff NUNCA recibía la suspensión y el producer no validaba el payload. Este test falla si un
 * eventType de fleet NO está registrado en EVENT_SCHEMAS o vuelve a la notación con-puntos.
 */
import { describe, it, expect } from 'vitest';
import { schemaForEvent } from '@veo/events';
import { FleetEventType } from './fleet-events';

describe('FleetEventType · alineación con EVENT_SCHEMAS', () => {
  it('cada eventType de fleet está REGISTRADO en EVENT_SCHEMAS (casa con consumers; el producer valida)', () => {
    for (const eventType of Object.values(FleetEventType)) {
      expect(schemaForEvent(eventType), `${eventType} no está en EVENT_SCHEMAS`).toBeDefined();
    }
  });

  it('respeta la convención dominio.snake_case (UN punto: fleet.driver_suspended, no fleet.driver.suspended)', () => {
    for (const eventType of Object.values(FleetEventType)) {
      expect(eventType.split('.'), `${eventType} no es dominio.evento`).toHaveLength(2);
      expect(eventType.startsWith('fleet.')).toBe(true);
    }
  });
});
