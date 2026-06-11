/**
 * Implementación del hot index sobre Redis real (producción).
 * - `driver:loc:{id}`  → JSON {lat,lon,h3,updatedAt} con TTL (si no pinguea, deja de ser candidato).
 * - `h3:available:{cell}` → SET de driverId disponibles en esa celda H3 (res 9).
 * - `driver:busy:{id}`  → flag de ocupado (asignado/en viaje): fuera del pool.
 *
 * El movimiento de un conductor entre celdas (SREM celda vieja + SADD celda nueva + refresh loc)
 * se hace con un script LUA atómico para evitar estados intermedios inconsistentes.
 */
import type Redis from 'ioredis';
import { toH3, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import type { DriverLocation, HotIndex } from './hot-index.port';

const LOC_PREFIX = 'driver:loc:';
const BUSY_PREFIX = 'driver:busy:';
const AVAIL_PREFIX = 'h3:available:';
/// Margen amplio para el flag de ocupado; se limpia explícitamente al completar/cancelar el viaje.
const BUSY_TTL_SECONDS = 7_200;

/**
 * KEYS[1]=set celda vieja, KEYS[2]=set celda nueva, KEYS[3]=loc, KEYS[4]=busy
 * ARGV[1]=driverId, ARGV[2]=locJson, ARGV[3]=ttl(s)
 * Devuelve 1 si quedó en el pool disponible, 0 si está ocupado (solo refresca loc).
 */
const MOVE_SCRIPT = `
local busy = redis.call('EXISTS', KEYS[4])
if KEYS[1] ~= KEYS[2] then
  redis.call('SREM', KEYS[1], ARGV[1])
end
if busy == 1 then
  redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
return 1
`;

export class RedisHotIndex implements HotIndex {
  constructor(
    private readonly redis: Redis,
    private readonly locTtlSeconds: number,
  ) {}

  private locKey(id: string): string {
    return `${LOC_PREFIX}${id}`;
  }
  private busyKey(id: string): string {
    return `${BUSY_PREFIX}${id}`;
  }
  private availKey(cell: string): string {
    return `${AVAIL_PREFIX}${cell}`;
  }

  async upsertLocation(
    driverId: string,
    point: LatLon,
    vehicleType: VehicleClass,
  ): Promise<DriverLocation> {
    const h3 = toH3(point, DISPATCH_H3_RESOLUTION);
    const prev = await this.getLocation(driverId);
    const oldCell = prev?.h3 ?? h3;
    const loc: DriverLocation = {
      driverId,
      lat: point.lat,
      lon: point.lon,
      h3,
      vehicleType,
      updatedAt: Date.now(),
    };
    await this.redis.eval(
      MOVE_SCRIPT,
      4,
      this.availKey(oldCell),
      this.availKey(h3),
      this.locKey(driverId),
      this.busyKey(driverId),
      driverId,
      JSON.stringify(loc),
      String(this.locTtlSeconds),
    );
    return loc;
  }

  async markBusy(driverId: string): Promise<void> {
    const loc = await this.getLocation(driverId);
    const pipeline = this.redis.multi();
    if (loc) pipeline.srem(this.availKey(loc.h3), driverId);
    pipeline.set(this.busyKey(driverId), '1', 'EX', BUSY_TTL_SECONDS);
    await pipeline.exec();
  }

  async markAvailable(driverId: string): Promise<void> {
    const loc = await this.getLocation(driverId);
    const pipeline = this.redis.multi();
    pipeline.del(this.busyKey(driverId));
    if (loc) pipeline.sadd(this.availKey(loc.h3), driverId);
    await pipeline.exec();
  }

  async remove(driverId: string): Promise<void> {
    const loc = await this.getLocation(driverId);
    const pipeline = this.redis.multi();
    if (loc) pipeline.srem(this.availKey(loc.h3), driverId);
    pipeline.del(this.locKey(driverId));
    pipeline.del(this.busyKey(driverId));
    await pipeline.exec();
  }

  async getLocation(driverId: string): Promise<DriverLocation | null> {
    const raw = await this.redis.get(this.locKey(driverId));
    if (!raw) return null;
    return RedisHotIndex.parseLocation(raw);
  }

  async candidates(cells: string[]): Promise<DriverLocation[]> {
    if (cells.length === 0) return [];
    const ids = await this.redis.sunion(...cells.map((c) => this.availKey(c)));
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => this.locKey(id)));
    const out: DriverLocation[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) continue; // loc expiró → ya no es candidato
      out.push(RedisHotIndex.parseLocation(raw));
    }
    return out;
  }

  async availableSample(cells: string[], limit: number): Promise<DriverLocation[]> {
    if (cells.length === 0 || limit <= 0) return [];
    // SRANDMEMBER con count es O(count), NO O(set): a diferencia de SUNION (que escanea TODAS las
    // celdas y bloquea el hilo único de Redis), acá tomamos a lo sumo `perCell` ids por celda. Así el
    // costo Redis + el MGET + el parse quedan acotados a ~`limit`, independiente de la densidad real.
    const perCell = Math.max(1, Math.ceil(limit / cells.length));
    const pipeline = this.redis.pipeline();
    for (const cell of cells) pipeline.srandmember(this.availKey(cell), perCell);
    const results = await pipeline.exec();
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of results ?? []) {
      const members = entry?.[1] as string[] | null;
      if (!members) continue;
      for (const id of members) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => this.locKey(id)));
    const out: DriverLocation[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) continue; // loc expiró → ya no es candidato
      out.push(RedisHotIndex.parseLocation(raw));
    }
    return out;
  }

  /**
   * Parsea una loc del Redis y normaliza vehicleType. El default CAR acá SE QUEDA (excepción explícita
   * del ADR 013 §5 · Lote D): el hot index tiene DATOS VIEJOS REALES — locs persistidas por pings
   * previos a Ola 2B sin el campo, que siguen vivas hasta que su TTL venza. No es un default que
   * oculte una clase nueva (una loc nueva SIEMPRE trae la clase: upsertLocation la exige), es la
   * lectura honesta de datos legacy en reposo.
   */
  private static parseLocation(raw: string): DriverLocation {
    const parsed = JSON.parse(raw) as Partial<DriverLocation> & DriverLocation;
    return { ...parsed, vehicleType: parsed.vehicleType ?? VehicleClass.CAR };
  }
}
