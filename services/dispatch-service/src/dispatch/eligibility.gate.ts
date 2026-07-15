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
import {
  VehicleClass,
  findOffering,
  hasRequiredCertifications,
  isVehicleEligibleForOffering,
} from '@veo/shared-types';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';
import {
  bumpEligibilityFailOpen,
  bumpEligibilityTierEvaluation,
  bumpEligibilityTierUnknown,
  classifyMissingAttr,
  offeringRestrictsByVehicleAttrs,
} from './dispatch.metrics';

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
   *
   * B5-3 — `category`: el tier/oferta del board (offeringId). Si viene, derivamos sus `requires`
   * (segment/seats/antigüedad/certs) y enforzamos la elegibilidad por TIER en la PUJA con la MISMA
   * semántica del pool de FIXED (`driver-pool.passesEligibility`): certs FAIL-CLOSED (una vertical exige
   * credencial válida), attrs del vehículo FAIL-OPEN (un ping legacy sin seats/segment/año NO se excluye,
   * para no romper el rollout). Sin `category` (compat N-2) o category desconocida ⇒ sin requisitos extra
   * ⇒ comportamiento previo (solo online/!suspendido/vehículo).
   */
  async assertEligibleToOffer(
    driverId: string,
    vehicleType: VehicleClass,
    fresh = false,
    category?: string,
    measureTier = false,
  ): Promise<void> {
    // Capa 3: estado autoritativo en identity (NO el hot-index). Falla-cerrado ante error de red.
    // FUENTE ÚNICA de la regla online/!suspendido (la reusa el accept de FIXED · assertActiveDriver).
    await this.assertActiveDriver(driverId, fresh);

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

    // B5-3 — ELEGIBILIDAD POR TIER (cierre del hueco PUJA): si el board lleva su oferta/tier, derivamos sus
    // `requires` y los enforzamos con la MISMA semántica del pool de FIXED (driver-pool.passesEligibility),
    // para que un conductor de tier inferior (ej. CAR económico de 4 asientos) NO pueda ofertar/ganar un bid
    // de tier superior (VEO_XL minSeats:6, VEO_PREMIUM minSegment:PREMIUM). Category ausente/desconocida ⇒
    // sin requires ⇒ comportamiento previo (solo vehicleType).
    // Resolución del TIER de la oferta. Si NO se puede resolver, no hay forma de gatear por attrs (fail-open
    // más amplio): lo MEDIMOS (era el blind-spot que el audit marcó a mirar a mano), sin romper el flujo.
    //  - category ausente  → compat N-2 (el board aún no la lleva): reason=absent.
    //  - category presente pero fuera del catálogo → drift/gap de catálogo: reason=unknown.
    //  - oferta resuelta SIN `requires` → no tier-gatea (ride básico): ni se mide ni se restringe.
    // La MEDICIÓN de tier-irresoluble (absent/unknown) solo corre con `measureTier` — los call-sites que SON
    // una decisión de tier por-board (submit/accept de un board específico). El POLL de /bids/open
    // (listOpenBidsNear) llama SIN category por diseño (lista N boards, no uno) y NO debe contaminar 'absent':
    // si bumpeara, 'absent' quedaría dominado por el volumen del poll y NUNCA tendería a 0 aunque el rollout de
    // category al board esté 100% completo → engañaría la decisión del flip. El ENFORCEMENT (certs/attrs) sí
    // corre siempre que la category resuelva, independiente de `measureTier`.
    if (!category) {
      if (measureTier) bumpEligibilityTierUnknown('absent');
    } else {
      const offering = findOffering(category);
      if (!offering) {
        if (measureTier) bumpEligibilityTierUnknown('unknown');
      } else if (offering.requires) {
        const requires = offering.requires;
        // Certs del conductor → FAIL-CLOSED: una vertical (ambulancia/grúa/mecánico) exige credencial VÁLIDA;
        // su AUSENCIA NO habilita (espeja el pool). Una oferta sin certs requeridas no se ve afectada.
        if (!hasRequiredCertifications(requires, loc.certifications)) {
          throw new ForbiddenError(
            'Conductor no elegible: faltan certificaciones requeridas por la oferta',
            { driverId, category },
          );
        }
        // Attrs del vehículo (seats/segment/año) → FAIL-OPEN, y SOLO si la oferta restringe por attrs (una
        // vertical certs-only no tier-gatea por asientos/segmento/año: medir su attr ausente inflaría el
        // numerador con fugas inexistentes y un flip naïve la falso-excluiría).
        if (offeringRestrictsByVehicleAttrs(requires)) {
          // DENOMINADOR de la prevalencia (source=gate): esta evaluación SÍ podría caer a fail-open.
          bumpEligibilityTierEvaluation('gate');
          // Solo se enforça cuando los TRES attrs están presentes; si falta alguno, fail-open medido.
          if (
            loc.seats !== undefined &&
            loc.segment !== undefined &&
            loc.vehicleYear !== undefined
          ) {
            const currentYear = new Date().getUTCFullYear();
            if (
              !isVehicleEligibleForOffering(
                requires,
                { seats: loc.seats, segment: loc.segment, year: loc.vehicleYear },
                currentYear,
              )
            ) {
              throw new ForbiddenError(
                'Conductor no elegible: el vehículo no cumple los requisitos de la oferta',
                { driverId, category },
              );
            }
          } else {
            // OBSERVABILIDAD (source=gate, CERO cambio de comportamiento): faltó algún attr → el gate
            // AUTORITATIVO de la PUJA deja pasar SIN verificar el tier por asientos/segmento/año. Lo MEDIMOS
            // (no lo cerramos: el flip a fail-closed sigue pendiente del gate adversarial) etiquetado `gate`
            // para dimensionar el blast-radius por superficie del submit/accept, separado del pool.
            bumpEligibilityFailOpen(
              'gate',
              classifyMissingAttr({
                seats: loc.seats !== undefined,
                segment: loc.segment !== undefined,
                year: loc.vehicleYear !== undefined,
              }),
            );
          }
        }
      }
    }
  }

  /**
   * FIXED (cierra la asimetría con PUJA · ALTA del gate wvv7pn1z0): re-valida que el conductor esté
   * ACTIVO contra identity — existe + online (AVAILABLE) + NO suspendido. Es la FUENTE ÚNICA de la
   * regla online/!suspendido: la usa el accept de FIXED (`DispatchService.accept`) y la reusa
   * `assertEligibleToOffer` (PUJA) antes de chequear vehículo/tier.
   *
   * El path FIXED (matching→pool→accept) confiaba SOLO en la presencia GPS del hot-index (stale): un
   * conductor suspendido que seguía pingeando recibía y aceptaba ofertas FIXED. Este gate cierra el eje
   * de ESTADO (suspensión/turno); no re-chequea vehículo/tier (la oferta FIXED ya matcheó el tipo al
   * ofertar). `fresh=true` en el accept (decisión de plata, sin cache, como el accept de PUJA). Falla-
   * cerrado: identity caído ⇒ ForbiddenError (403), nunca un suspendido colándose por un error de red.
   */
  async assertActiveDriver(driverId: string, fresh = false): Promise<void> {
    const snapshot = await this.identitySnapshot(driverId, fresh);
    if (!snapshot.found) {
      throw new ForbiddenError('Conductor no elegible: desconocido en identity', { driverId });
    }
    if (snapshot.suspendedAt !== null) {
      throw new ForbiddenError('Conductor no elegible: suspendido', { driverId });
    }
    if (snapshot.currentStatus !== ELIGIBLE_STATUS) {
      throw new ForbiddenError('Conductor no elegible: no está online/AVAILABLE (turno inactivo)', {
        driverId,
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
