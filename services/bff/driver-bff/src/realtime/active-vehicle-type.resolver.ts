/**
 * Resuelve el vehículo ACTIVO del conductor desde fleet (server-authoritative) para sellarlo en el ping de
 * GPS: su TIPO (clase del pool de matching) y —B5-3— sus atributos de ELIGIBILIDAD (asientos/segmento/año
 * del modelo elegido). ANTES el tipo lo declaraba el cliente en cada `location` sin validar (spoofeable: un
 * conductor de auto podía pedir viajes de MOTO); ahora el BFF lo sobreescribe con lo que el conductor tiene
 * SELECCIONADO + con docs vigentes en fleet, y suma los attrs para que dispatch filtre por oferta
 * (confort=segment≥MID, xl=6 asientos) SIN consultar fleet en el hot-path.
 *
 * El ping es por-segundo: resolver fleet en cada uno sería caro, así que cacheamos por conductor con TTL
 * corto. Un cambio de vehículo se refleja en ≤ TTL. Si fleet no responde o no hay vehículo operable (204),
 * degradación honesta: devolvemos solo el tipo `fallback` (lo que vino en el ping) SIN attrs — dispatch no
 * restringe a ese conductor (no peor que antes); no rompemos el envío de ubicación por una caída de fleet.
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { FleetDocumentType, VehicleClass, VehicleSegment } from '@veo/shared-types';
import { RestGateway } from '../infra/rest.gateway';

/** Subconjunto del response de fleet (`/drivers/vehicles/active`) que necesitamos para el ping. */
interface ActiveVehicleReply {
  /** Id del vehículo activo (DriverVehicleResponse.id) — se sella en el ping como key del carry de dispatch. */
  id?: string;
  vehicleType: VehicleClass;
  year?: number;
  seats?: number;
  segment?: VehicleSegment;
  certifications?: FleetDocumentType[];
}

/** Vehículo activo resuelto: tipo (siempre) + attrs de eligibilidad (si el modelo del catálogo los aporta). */
export interface ResolvedActiveVehicle {
  vehicleType: VehicleClass;
  /** Identidad del vehículo activo: dispatch keysea el carry anti-clobber por ESTO, no por vehicleType. */
  vehicleId?: string;
  seats?: number;
  segment?: VehicleSegment;
  vehicleYear?: number;
  /** B5-3.2 · certs vigentes del conductor para el gate de verticales en dispatch (fail-closed). */
  certifications?: FleetDocumentType[];
}

@Injectable()
export class ActiveVehicleTypeResolver {
  private readonly cache = new Map<string, { value: ResolvedActiveVehicle; expiresAt: number }>();
  /**
   * Generación (epoch) por conductor: la incrementa `invalidate`. Sirve de marca anti-TOCTOU para los
   * `resolve` EN VUELO: un resolve captura la generación ANTES del await a fleet y, al volver, solo escribe
   * la cache si la generación NO cambió. Si cambió, hubo un swap mientras la respuesta de fleet estaba en
   * vuelo → ese valor es potencialmente STALE y NO debe re-envenenar la cache (ADR-017 §5(d) landmine d.2).
   * Es un entero por conductor invalidado (footprint despreciable); NO se podan ni se resetean en
   * `invalidate` (resetear a 0 reabriría la race para un resolve que ya capturó gen≥1).
   */
  private readonly generation = new Map<string, number>();
  private static readonly TTL_MS = 20_000;

  constructor(private readonly rest: RestGateway) {}

  /**
   * Vehículo activo del conductor para el ping. `fallback` (tipo) se usa si fleet no responde o no hay
   * vehículo operable (204): en ese caso devolvemos solo el tipo, SIN attrs (degradación honesta). La
   * clave de cache es el `userId` (lo que fleet usa como `driver_id`).
   *
   * INVARIANTE EPOCH (anti-TOCTOU): el GET a fleet es un punto de yield. Capturamos la generación de la key
   * ANTES del await; al volver, solo cacheamos si la generación SIGUE igual. Si un `invalidate` corrió
   * mientras la respuesta estaba en vuelo (swap de vehículo concurrente), la generación cambió y NO
   * escribimos la cache: este `value` puede reflejar el vehículo VIEJO (fleet leyó antes de que el swap
   * commiteara), y cachearlo re-envenenaría la entrada por todo el TTL. En ese caso devolvemos el `value`
   * recién resuelto a ESTE caller (es lo mejor que tenemos para este ping puntual) pero sin persistirlo, así
   * el próximo ping hace cache-miss y re-resuelve fresco (post-swap).
   */
  async resolve(
    identity: AuthenticatedUser,
    fallback: VehicleClass,
  ): Promise<ResolvedActiveVehicle> {
    const key = identity.userId;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const gen = this.generation.get(key) ?? 0;
    try {
      const active = await this.rest
        .client('fleet')
        .get<ActiveVehicleReply | undefined>('/drivers/vehicles/active', { identity });
      const value: ResolvedActiveVehicle = active
        ? {
            vehicleType: active.vehicleType,
            vehicleId: active.id,
            seats: active.seats,
            segment: active.segment,
            vehicleYear: active.year,
            certifications: active.certifications,
          }
        : { vehicleType: fallback };
      // Guard epoch: solo cacheamos si NO hubo un invalidate mientras el GET estaba en vuelo. Si lo hubo
      // (generación cambió), devolvemos el valor a este caller pero NO lo persistimos (anti re-envenenamiento).
      if ((this.generation.get(key) ?? 0) === gen) {
        this.cache.set(key, { value, expiresAt: now + ActiveVehicleTypeResolver.TTL_MS });
      }
      return value;
    } catch {
      return { vehicleType: fallback };
    }
  }

  /**
   * Invalida explícitamente la entrada cacheada de un conductor. La llama el comando que CAMBIA el vehículo
   * activo (drivers.service.setActiveVehicle) tras un PATCH exitoso a fleet: sin esto el swap recién se
   * reflejaría en el ping al vencer el TTL (ventana stale de ≤ TTL_MS, ADR-017 §5(d) landmine d.2). El
   * próximo `resolve` ve cache-miss y re-lee fleet (server-authoritative). Operación local idempotente: si
   * la key no estaba (TTL ya vencido o nunca resuelta), `delete` es no-op. La clave es el `userId` (lo que
   * fleet usa como `driver_id`), igual que en `resolve`.
   *
   * Además de borrar la cache, INCREMENTA la generación (epoch) de la key: esto neutraliza los `resolve` EN
   * VUELO. Sin esto, un `resolve` que disparó su GET a fleet ANTES del swap puede volver DESPUÉS del delete y
   * re-escribir la cache con el vehículo VIEJO (TOCTOU read-then-invalidate), dejándola envenenada por todo
   * el TTL. La generación NO se resetea a 0 (eso reabriría la race para un resolve que capturó gen≥1).
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
  }
}
