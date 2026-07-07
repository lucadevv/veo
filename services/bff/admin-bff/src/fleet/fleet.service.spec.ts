/**
 * FleetService (admin-bff) · B5-2.c — revisión del catálogo de modelos.
 * Lo crítico a fijar: approve/reject proxyean a fleet y SIEMPRE registran un audit (Ley 29733: toda
 * acción del operador queda trazada). listModelReview pasa el filtro de estado tal cual.
 */
import { describe, it, expect, vi } from 'vitest';
import { FleetService } from './fleet.service';

// gRPC de enriquecimiento (nombre/ITV) + config del secret: no-op para los tests de catálogo de modelos (no
// tocan listVehicles). GetUsersByIds → {users:[]}, GetVehiclesInspectionStatus → {items:[]} (ambos vacíos).
const grpcNoop = { call: vi.fn().mockResolvedValue({ users: [], items: [] }) };
const configNoop = { get: vi.fn().mockReturnValue('dev-secret') };

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
  const svc = new FleetService(
    rest as never,
    grpcNoop as never,
    grpcNoop as never,
    'admin-rail' as never,
    configNoop as never,
    audit as never,
  );
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

describe('FleetService.expirations · cola paginada (cursor compuesto)', () => {
  it('propaga days + cursor + limit a fleet GET /fleet/expirations y devuelve envelope con nextCursor', async () => {
    const rest = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'd1',
            ownerType: 'DRIVER',
            ownerId: 'drv-1',
            type: 'LICENSE_A1',
            status: 'EXPIRING_SOON',
            expiresAt: '2026-07-10T00:00:00.000Z',
          },
        ],
        nextCursor: '2026-07-10T00:00:00.000Z|d1',
      }),
      put: vi.fn(),
      post: vi.fn(),
    };
    const audit = { record: vi.fn() };
    const svc = new FleetService(
      rest as never,
      grpcNoop as never,
      grpcNoop as never,
      'admin-rail' as never,
      configNoop as never,
      audit as never,
    );

    const page = await svc.expirations(operator, {
      days: 30,
      cursor: '2026-07-01T00:00:00.000Z|d0',
      limit: 50,
    } as never);

    expect(rest.get).toHaveBeenCalledWith(
      '/fleet/expirations',
      expect.objectContaining({
        query: expect.objectContaining({
          days: 30,
          cursor: '2026-07-01T00:00:00.000Z|d0',
          limit: 50,
        }),
      }),
    );
    expect(page.nextCursor).toBe('2026-07-10T00:00:00.000Z|d1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'd1', daysUntilExpiry: expect.any(Number) });
  });

  it('descarta items sin expiresAt en el map PERO preserva el nextCursor de fleet (filtro post-paginado)', async () => {
    const rest = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'd1',
            ownerType: 'DRIVER',
            ownerId: 'drv-1',
            type: 'LICENSE_A1',
            status: 'EXPIRING_SOON',
            expiresAt: null,
          },
          {
            id: 'd2',
            ownerType: 'VEHICLE',
            ownerId: 'veh-1',
            type: 'SOAT',
            status: 'EXPIRED',
            expiresAt: '2026-07-05T00:00:00.000Z',
          },
        ],
        nextCursor: '2026-07-05T00:00:00.000Z|d2',
      }),
      put: vi.fn(),
      post: vi.fn(),
    };
    const audit = { record: vi.fn() };
    const svc = new FleetService(
      rest as never,
      grpcNoop as never,
      grpcNoop as never,
      'admin-rail' as never,
      configNoop as never,
      audit as never,
    );

    const page = await svc.expirations(operator, {} as never);
    // d1 (sin expiresAt) se descarta → página de 1, pero el cursor de avance NO se rompe.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe('d2');
    expect(page.nextCursor).toBe('2026-07-05T00:00:00.000Z|d2');
  });
});
