/**
 * Exclusión por SUSPENSIÓN sobre Redis con TTL de AUTO-CURA (una key por conductor con EXPIRE, NO un SET).
 *
 * Por qué TTL y no un SET pegajoso (como el de pánico). Al set entran DOS ejes: el DISCIPLINARIO
 * (`driver.suspended`) y el FLEET doc/ITV (`fleet.driver_suspended`, Lote 2b). La des-exclusión por evento
 * es PRONTA en ambos (onReactivated/onFleetReactivated holds-aware), pero puede no llegar/llegar tarde:
 * (a) CARRERA del eje fleet — dispatch e identity consumen el MISMO `fleet.driver_reactivated` en paralelo,
 * así dispatch puede re-validar `suspendedAt` antes de que identity confirme el quite del hold y leer estado
 * viejo → MANTIENE excluido a un conductor que ya quedó ACTIVO; (b) pérdida dura del evento. Sin TTL ese
 * conductor —ya activo— quedaría excluido para SIEMPRE → shadow-ban silencioso, recuperable solo con cirugía
 * manual en Redis. Eso es OVER-exclusion, y el accept-gate fail-closed NO la rescata: cubre el inverso (el
 * suspendido que se cuela = UNDER-exclusion).
 *
 * El TTL invierte el modo de falla hacia el lado SEGURO: si la señal de cierre nunca llega, la exclusión
 * EXPIRA y el conductor RE-ENTRA al pool. Si seguía suspendido, el accept-gate lo 403ea (under-exclusion,
 * oferta-desperdiciada acotada por el set `attempted` de la sesión); si ya estaba activo, recibe ofertas
 * (correcto). La exclusión es una OPTIMIZACIÓN (no ofertarle de gusto al suspendido); la AUTORIDAD de
 * seguridad es el accept-gate. La reactivación holds-aware sigue limpiando al INSTANTE en el caso normal
 * (DriverSuspensionService.onReactivated) — el TTL es el piso de auto-cura para cuando esa señal no llega.
 *
 * Implementación per-key (no SET): Redis expira cada key solo → cero crecimiento, sin reconciler/cron. El
 * `filter` resuelve en UN round-trip (MGET). Re-excluir REFRESCA el TTL (idempotente + renueva la ventana).
 */
import type Redis from 'ioredis';
import type { ExclusionRegistry } from './hot-index.port';

/** Prefijo de la key por-conductor. La key es `${prefix}:${driverId}` (no un SET con miembros). */
const SUSPENDED_KEY_PREFIX = 'dispatch:suspended:driver';

export class RedisTtlExclusionRegistry implements ExclusionRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly keyPrefix: string = SUSPENDED_KEY_PREFIX,
  ) {}

  private key(driverId: string): string {
    return `${this.keyPrefix}:${driverId}`;
  }

  async exclude(driverId: string): Promise<void> {
    // SET con EXPIRE: re-excluir es idempotente y REFRESCA el TTL (renueva la ventana en cada re-entrega).
    await this.redis.set(this.key(driverId), '1', 'EX', this.ttlSeconds);
  }

  async isExcluded(driverId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(driverId))) === 1;
  }

  async filter(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];
    // MGET en un solo round-trip: una key ausente o ya expirada vuelve `null` → ese conductor NO está excluido.
    const vals = await this.redis.mget(driverIds.map((id) => this.key(id)));
    return driverIds.filter((_, i) => vals[i] === null);
  }

  async clear(driverId: string): Promise<void> {
    await this.redis.del(this.key(driverId));
  }
}
