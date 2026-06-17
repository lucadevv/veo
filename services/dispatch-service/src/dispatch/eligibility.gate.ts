/**
 * EligibilityGate — cierre estructural del catastrófico #9 de la auditoría (ADR 010 §0, §6).
 *
 * Un conductor SOLO puede ofertar/contraofertar en una PUJA si es ELEGIBLE. La elegibilidad se
 * enforce en la ACCIÓN de ofertar (no en la presencia GPS), y se RE-VALIDA contra la fuente
 * autoritativa (identity-service por gRPC, MENTORIA capa 3 · defensa en profundidad):
 *
 *   1. ONLINE / AVAILABLE  → identity.currentStatus === 'AVAILABLE' (pasó el gate biométrico de turno;
 *      OFFLINE/ON_TRIP/ASSIGNED/ON_BREAK/SUSPENDED ⇒ no puede ofertar).
 *   2. NO SUSPENDIDO       → identity.suspendedAt == null.
 *   3. VEHÍCULO COINCIDE   → el vehículo ACTIVO del conductor (proyectado en el hot-index desde
 *      `driver.location_updated`) coincide con el `vehicleType` del bid (un viaje MOTO solo a MOTO).
 *
 * La PRESENCIA en el hot-index de GPS NO basta para ofertar: confirma posición y tipo de vehículo,
 * pero el estado online/suspendido es autoritativo en identity. Si identity no responde, el gate
 * FALLA-CERRADO (degradación honesta: nunca un conductor no elegible colándose por un error de red).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';

/** Estado de identity que habilita ofertar: el conductor está online y disponible (turno activo). */
const ELIGIBLE_STATUS = 'AVAILABLE';

/** Token DI del TTL (ms) del cache de elegibilidad; lo provee el módulo desde ELIGIBILITY_CACHE_TTL_MS. */
export const ELIGIBILITY_CACHE_TTL_MS = Symbol('ELIGIBILITY_CACHE_TTL_MS');

/**
 * H11 — cota dura del cache in-proc de elegibilidad. Sin esto el `Map` solo hacía `set` (las entradas
 * vencidas se saltaban en la lectura pero nunca se borraban) → una entrada por CADA driver visto, para
 * siempre, hasta reiniciar el proceso. Con el cap, al superarlo se evicta la entrada MÁS VIEJA (el `Map`
 * preserva el orden de inserción → la primera clave es la más antigua). 10k drivers × ~120B ≈ acotado.
 */
const ELIGIBILITY_CACHE_MAX_SIZE = 10_000;

/** Snapshot autoritativo de identity que el cache guarda (SOLO lecturas exitosas). */
interface IdentitySnapshot {
  found: boolean;
  currentStatus: string;
  suspendedAt: string | null;
}

@Injectable()
export class EligibilityGate {
  private readonly logger = new Logger(EligibilityGate.name);

  /**
   * A4 — cache in-proc de corto TTL del snapshot autoritativo de identity, keyed por driverId. El gate
   * hacía un gRPC a identity por CADA submit/listOpenBidsNear; el poll de /bids/open (cada 2-3s) lo
   * martillaba por un estado que cambia en el orden de MINUTOS. El cache absorbe el path read-heavy.
   * In-proc Map (no distribuido): correcto para el poll, y per-instancia es aceptable porque el TTL es
   * diminuto. SOLO se cachean lecturas EXITOSAS; un fallo de red NUNCA se cachea (sigue fallando-cerrado).
   * El path de ACCEPT (la decisión de plata) BYPASEA el cache (`fresh=true`) para leer estado fresco.
   * H11 — el Map está ACOTADO: una entrada vencida se BORRA al leerla (no solo se salta), y un cap duro
   * (`ELIGIBILITY_CACHE_MAX_SIZE`) evicta la entrada más vieja al superarlo → memoria acotada sin reinicio.
   */
  private readonly cache = new Map<string, { snapshot: IdentitySnapshot; expiresAt: number }>();

  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClient,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Optional() @Inject(ELIGIBILITY_CACHE_TTL_MS) private readonly cacheTtlMs = 3_000,
  ) {}

  /**
   * Lanza ForbiddenError (403) si el conductor NO puede ofertar en una puja del `vehicleType` dado.
   * Re-valida contra identity (online + !suspendido) y contra el hot-index (vehículo activo).
   *
   * A4 — `fresh`: si es true, BYPASEA el cache de identity y lee fresco (path de ACCEPT, la decisión de
   * plata: un conductor recién suspendido no puede colarse por un snapshot stale de hasta `cacheTtlMs`).
   * El path de SUBMIT/LIST usa el cache (read-heavy, estado que cambia en minutos). Default = con cache.
   */
  async assertEligibleToOffer(
    driverId: string,
    vehicleType: VehicleClass,
    fresh = false,
  ): Promise<void> {
    // Capa 3: estado autoritativo en identity (NO el hot-index). Falla-cerrado ante error de red.
    const snapshot = await this.identitySnapshot(driverId, fresh);
    if (!snapshot.found) {
      throw new ForbiddenError('Conductor no elegible: desconocido en identity', { driverId });
    }
    const online = snapshot.currentStatus === ELIGIBLE_STATUS;
    const suspended = snapshot.suspendedAt !== null;

    if (suspended) {
      throw new ForbiddenError('Conductor no elegible: suspendido', { driverId });
    }
    if (!online) {
      throw new ForbiddenError('Conductor no elegible: no está online/AVAILABLE (turno inactivo)', {
        driverId,
      });
    }

    // Vehículo activo: lo proyecta el hot-index desde driver.location_updated. La presencia GPS no
    // autoriza por sí sola (las dos validaciones de arriba ya corrieron), pero sí aporta el tipo.
    const loc = await this.hotIndex.getLocation(driverId);
    if (!loc) {
      throw new ForbiddenError(
        'Conductor no elegible: sin ubicación activa (vehículo desconocido)',
        {
          driverId,
        },
      );
    }
    if (loc.vehicleType !== vehicleType) {
      throw new ForbiddenError('Conductor no elegible: el vehículo no coincide con la puja', {
        driverId,
        expected: vehicleType,
        actual: loc.vehicleType,
      });
    }
  }

  /**
   * A4 — devuelve el snapshot de identity, sirviéndolo del cache de corto TTL salvo que `fresh=true`.
   * Reglas:
   *  - `fresh=true`         → SIEMPRE pega a identity (path de ACCEPT). El resultado refresca el cache.
   *  - hit no vencido       → del cache, SIN gRPC (absorbe el poll read-heavy de /bids/open).
   *  - miss / vencido       → pega a identity; cachea SOLO si la lectura fue EXITOSA.
   *  - error de red / gRPC  → NUNCA se cachea; se relanza como ForbiddenError (falla-cerrado, como antes).
   * Con TTL=0 el cache queda efectivamente deshabilitado (un hit guardado expira de inmediato).
   */
  private async identitySnapshot(driverId: string, fresh: boolean): Promise<IdentitySnapshot> {
    const now = Date.now();
    if (!fresh) {
      const hit = this.cache.get(driverId);
      if (hit) {
        if (hit.expiresAt > now) return hit.snapshot;
        // H11 — entrada vencida: la BORRA (antes solo se saltaba → fuga: el Map nunca se achicaba).
        this.cache.delete(driverId);
      }
    }
    let snapshot: IdentitySnapshot;
    try {
      const driver = await this.identity.getDriver(driverId);
      snapshot = {
        found: driver.found,
        currentStatus: driver.currentStatus,
        suspendedAt: driver.suspendedAt,
      };
    } catch (err) {
      // Falla-cerrado: NO cacheamos el error; el caller lo convierte en 403 (igual que antes de A4).
      this.logger.warn(`identity no disponible para gate de ${driverId}: ${String(err)}`);
      throw new ForbiddenError('Conductor no elegible: no se pudo validar el estado en identity', {
        driverId,
      });
    }
    // Cachea SOLO lecturas EXITOSAS (incluido found=false, que es una respuesta autoritativa válida).
    if (this.cacheTtlMs > 0) {
      // H11 — re-`set` mueve la clave al final del orden de inserción (refresca su "edad").
      this.cache.delete(driverId);
      this.cache.set(driverId, { snapshot, expiresAt: now + this.cacheTtlMs });
      // Cota dura: si superamos el cap, evicta la entrada más vieja (la primera clave del Map).
      if (this.cache.size > ELIGIBILITY_CACHE_MAX_SIZE) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return snapshot;
  }
}

export { VehicleClass };
