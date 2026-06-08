/** Test del publicador de ubicación: construye y publica driver.location_updated con su celda H3. */
import { describe, it, expect, vi } from 'vitest';
import { toH3 } from '@veo/utils';
import type { DriverLocationReport } from '@veo/api-client';
import type { EventEnvelope } from '@veo/events';
import { LocationPublisherService } from './location-publisher.service';

const report: DriverLocationReport = {
  lat: -12.0464,
  lon: -77.0428,
  heading: 90,
  speed: 8.3,
  accuracy: 5,
  ts: '2026-05-29T00:00:00.000Z',
};

function makeService(publishImpl?: () => Promise<void>) {
  const config = { getOrThrow: () => 'localhost:9094' };
  const service = new LocationPublisherService(config as never);
  const publish = vi.fn(publishImpl ?? (() => Promise.resolve()));
  // Inyecta un productor ya "conectado" para evitar I/O de red en el test.
  (service as unknown as { producer: { publish: typeof publish }; connected: boolean }).producer = {
    publish,
  };
  (service as unknown as { connected: boolean }).connected = true;
  return { service, publish };
}

describe('LocationPublisherService.publishDriverLocation', () => {
  it('publica el evento con point + h3 derivado y key=driverId', async () => {
    const { service, publish } = makeService();
    const ok = await service.publishDriverLocation('drv-1', report);
    expect(ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);

    const [envelope, key] = publish.mock.calls[0] as unknown as [EventEnvelope<unknown>, string];
    expect(key).toBe('drv-1');
    expect(envelope.eventType).toBe('driver.location_updated');
    expect(envelope.producer).toBe('driver-bff');
    expect(envelope.payload).toEqual({
      driverId: 'drv-1',
      point: { lat: report.lat, lon: report.lon },
      h3: toH3({ lat: report.lat, lon: report.lon }),
      at: report.ts,
      // Ola 2B: el tipo de vehículo activo se incluye (default CAR si la app no lo envía).
      vehicleType: 'CAR',
    });
  });

  it('devuelve false (no lanza) si el productor falla', async () => {
    const { service } = makeService(() => Promise.reject(new Error('kafka down')));
    const ok = await service.publishDriverLocation('drv-1', report);
    expect(ok).toBe(false);
  });
});
