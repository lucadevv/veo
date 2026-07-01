/**
 * Dobles en memoria del hot index y del registro de exclusión, que respetan el MISMO contrato
 * que las implementaciones Redis. Uso exclusivo en tests unitarios (no es un mock: es una
 * implementación real en memoria). La integración usa Redis real (testcontainers / localhost).
 */
import { toH3, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import type {
  DriverLocation,
  DriverVehicleAttrs,
  ExclusionRegistry,
  HotIndex,
} from './hot-index.port';

export class InMemoryHotIndex implements HotIndex {
  private readonly locations = new Map<string, DriverLocation>();
  private readonly busy = new Set<string>();

  async upsertLocation(
    driverId: string,
    point: LatLon,
    vehicleType: VehicleClass,
    attrs?: DriverVehicleAttrs,
  ): Promise<DriverLocation> {
    // Paridad de contrato con RedisHotIndex.upsertLocation: el anti-clobber de attrs de tier. Un ping que
    // OMITE los attrs preserva los del ping previo SOLO si es EL MISMO VEHÍCULO probado por vehicleId (las
    // certs NO se preservan: fail-closed). Ver el comentario canónico en redis-hot-index.ts.
    const prev = this.locations.get(driverId);
    // Paridad con redis-hot-index: el carry se llavea ESTRICTO por vehicleId (IDENTIDAD), SIN fallback por
    // vehicleType (landmine d.1 · ADR-017 §5(d)). Sin vehicleId no hay carry: cero stale. Razonamiento completo
    // en el comentario canónico de redis-hot-index.ts.
    const sameVehicle = attrs?.vehicleId !== undefined && prev?.vehicleId === attrs.vehicleId;
    const carry = sameVehicle ? prev : undefined;
    const seats = attrs?.seats ?? carry?.seats;
    const segment = attrs?.segment ?? carry?.segment;
    const vehicleYear = attrs?.vehicleYear ?? carry?.vehicleYear;
    const loc: DriverLocation = {
      driverId,
      lat: point.lat,
      lon: point.lon,
      h3: toH3(point, DISPATCH_H3_RESOLUTION),
      vehicleType,
      // IDENTIDAD estricta del ping (no se arrastra del carry); key del carry anti-clobber (Lote 2).
      ...(attrs?.vehicleId !== undefined ? { vehicleId: attrs.vehicleId } : {}),
      ...(seats !== undefined ? { seats } : {}),
      ...(segment !== undefined ? { segment } : {}),
      ...(vehicleYear !== undefined ? { vehicleYear } : {}),
      ...(attrs?.certifications !== undefined ? { certifications: attrs.certifications } : {}),
      updatedAt: Date.now(),
    };
    this.locations.set(driverId, loc);
    return loc;
  }

  /** Atajo de test: ubica a un conductor directamente en una celda H3 conocida (+ attrs de eligibilidad). */
  async seed(
    driverId: string,
    lat: number,
    lon: number,
    h3: string,
    vehicleType: VehicleClass = VehicleClass.CAR,
    attrs?: DriverVehicleAttrs,
  ): Promise<void> {
    this.locations.set(driverId, {
      driverId,
      lat,
      lon,
      h3,
      vehicleType,
      ...(attrs?.vehicleId !== undefined ? { vehicleId: attrs.vehicleId } : {}),
      ...(attrs?.seats !== undefined ? { seats: attrs.seats } : {}),
      ...(attrs?.segment !== undefined ? { segment: attrs.segment } : {}),
      ...(attrs?.vehicleYear !== undefined ? { vehicleYear: attrs.vehicleYear } : {}),
      ...(attrs?.certifications !== undefined ? { certifications: attrs.certifications } : {}),
      updatedAt: Date.now(),
    });
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

  async countOnline(): Promise<number> {
    // Mismo contrato que RedisHotIndex.countOnline: presencia de loc = "en línea" (disponible u ocupado).
    // Redis lo sirve con un ÍNDICE de presencia (ZSET `drivers:online`, O(log n) + ventana TTL); acá el
    // `Map` de ubicaciones ES ese índice (upsert→set, remove→delete lo mantienen), así que su `size` es el
    // equivalente fiel. No hay expiración por tiempo en este doble (los tests siembran y cuentan al toque),
    // por eso no se filtra por ventana — la MEMBRESÍA es la misma verdad que el ZSET modela en Redis.
    return this.locations.size;
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
