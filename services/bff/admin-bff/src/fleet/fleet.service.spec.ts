/**
 * FleetService (admin-bff) · B5-2.c — revisión del catálogo de modelos.
 * Lo crítico a fijar: approve/reject proxyean a fleet y SIEMPRE registran un audit (Ley 29733: toda
 * acción del operador queda trazada). listModelReview pasa el filtro de estado tal cual.
 */
import { describe, it, expect, vi } from 'vitest';
import { FleetService } from './fleet.service';

function makeService(restOver: Record<string, unknown> = {}) {
  const rest = {
    get: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    put: vi
      .fn()
      .mockResolvedValue({ id: 'm1', make: 'Toyota', model: 'Probox', status: 'APPROVED' }),
    post: vi.fn(),
    ...restOver,
  };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const svc = new FleetService(rest as never, audit as never);
  return { svc, rest, audit };
}

const operator = { userId: 'op-1', type: 'admin', roles: ['ADMIN'] } as never;

describe('FleetService.approveModel · B5-2.c', () => {
  it('proxya a PUT /vehicle-models/:id/approve con la ficha y AUDITA la acción', async () => {
    const { svc, rest, audit } = makeService();
    await svc.approveModel(operator, 'm1', {
      segment: 'MID',
      energySource: 'DIESEL',
      efficiency: 12,
    } as never);
    expect(rest.put).toHaveBeenCalledWith(
      '/vehicle-models/m1/approve',
      expect.objectContaining({
        body: { segment: 'MID', energySource: 'DIESEL', efficiency: 12 },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        action: 'vehicle_model.approve',
        resourceType: 'vehicle_model',
        resourceId: 'm1',
      }),
    );
  });
});

describe('FleetService.rejectModel · B5-2.c', () => {
  it('proxya a PUT /vehicle-models/:id/reject y AUDITA la acción', async () => {
    const { svc, rest, audit } = makeService();
    await svc.rejectModel(operator, 'm9');
    expect(rest.put).toHaveBeenCalledWith(
      '/vehicle-models/m9/reject',
      expect.objectContaining({ body: {} }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        action: 'vehicle_model.reject',
        resourceType: 'vehicle_model',
        resourceId: 'm9',
      }),
    );
  });
});

describe('FleetService.listModelReview · B5-2.c', () => {
  it('pasa el filtro de estado a fleet GET /vehicle-models/review', async () => {
    const { svc, rest } = makeService();
    await svc.listModelReview(operator, { status: 'REJECTED', limit: 10 } as never);
    expect(rest.get).toHaveBeenCalledWith(
      '/vehicle-models/review',
      expect.objectContaining({
        query: expect.objectContaining({ status: 'REJECTED', limit: 10 }),
      }),
    );
  });
});
