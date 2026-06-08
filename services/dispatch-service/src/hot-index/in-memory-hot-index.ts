/**
 * Dobles en memoria del hot index y del registro de exclusión, que respetan el MISMO contrato
 * que las implementaciones Redis. Uso exclusivo en tests unitarios (no es un mock: es una
 * implementación real en memoria). La integración usa Redis real (testcontainers / localhost).
 */
import { toH3, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import type { DriverLocation, ExclusionRegistry, HotIndex } from './hot-index.port';

export class InMemoryHotIndex implements HotIndex {
  private readonly locations = new Map<string, DriverLocation>();
  private readonly busy = new Set<string>();

  async upsertLocation(
    driverId: string,
    point: LatLon,
    vehicleType: VehicleType = VehicleType.CAR,
  ): Promise<DriverLocation> {
    const loc: DriverLocation = {
      driverId,
      lat: point.lat,
      lon: point.lon,
      h3: toH3(point, DISPATCH_H3_RESOLUTION),
      vehicleType,
      updatedAt: Date.now(),
    };
    this.locations.set(driverId, loc);
    return loc;
  }

  /** Atajo de test: ubica a un conductor directamente en una celda H3 conocida. */
  async seed(
    driverId: string,
    lat: number,
    lon: number,
    h3: string,
    vehicleType: VehicleType = VehicleType.CAR,
  ): Promise<void> {
    this.locations.set(driverId, { driverId, lat, lon, h3, vehicleType, updatedAt: Date.now() });
  }

  /** Atajo de test: vacía el índice por completo (aislamiento entre casos). */
  async clear(): Promise<void> {
    this.locations.clear();
    this.busy.clear();
  }

  async markBusy(driverId: string): Promise<void> {
    this.busy.add(driverId);
  }

  async markAvailable(driverId: string): Promise<void> {
    this.busy.delete(driverId);
  }

  async remove(driverId: string): Promise<void> {
    this.locations.delete(driverId);
    this.busy.delete(driverId);
  }

  async getLocation(driverId: string): Promise<DriverLocation | null> {
    return this.locations.get(driverId) ?? null;
  }

  async candidates(cells: string[]): Promise<DriverLocation[]> {
    const set = new Set(cells);
    const out: DriverLocation[] = [];
    for (const loc of this.locations.values()) {
      if (set.has(loc.h3) && !this.busy.has(loc.driverId)) out.push(loc);
    }
    return out;
  }

  async availableSample(cells: string[], limit: number): Promise<DriverLocation[]> {
    if (cells.length === 0 || limit <= 0) return [];
    // Mismo contrato que RedisHotIndex.availableSample: a lo sumo `limit`, sin garantía de cercanía.
    const all = await this.candidates(cells);
    return all.slice(0, limit);
  }
}

export class InMemoryExclusionRegistry implements ExclusionRegistry {
  private readonly excluded = new Set<string>();

  async exclude(driverId: string): Promise<void> {
    this.excluded.add(driverId);
  }
  async isExcluded(driverId: string): Promise<boolean> {
    return this.excluded.has(driverId);
  }
  async filter(driverIds: string[]): Promise<string[]> {
    return driverIds.filter((id) => !this.excluded.has(id));
  }
  async clear(driverId: string): Promise<void> {
    this.excluded.delete(driverId);
  }
}
