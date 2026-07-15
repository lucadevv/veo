/**
 * OperableVehicleClassesProvider (dispatch) — resuelve las CLASES de vehículo operables HOY desde el catálogo
 * EFECTIVO del admin (base ⟕ overlay runtime). Portado del gate de alta de fleet-service (mismo patrón: REST
 * interno firmado a `GET /internal/catalog` de trip-service + helper puro `operableVehicleClasses` + cache in-proc
 * de un slot con TTL corto + degradación conservadora). Acá alimenta el FILTRO DEFENSIVO del pool de dispatch
 * (`DriverPool.eligible`, seam catálogo↔operabilidad · ADR 013): excluye del pool a los conductores cuya clase de
 * vehículo NO esté operable.
 *
 * SECUNDARIO (defensa en profundidad): en el happy-path es REDUNDANTE — una categoría apagada no genera viajes de
 * esa clase (no hay quote/createTrip), y el mecanismo PRIMARIO son los holds CATEGORY_DISABLED que fleet siembra en
 * identity (suspenden al conductor: `startShift` corta + el enforcement en vivo lo baja). Este filtro cierra el
 * hueco residual (un conductor de la clase apagada que quedara pingeando GPS sin hold aún) sin ser la primera línea.
 *
 * DEGRADACIÓN HONESTA (CONSERVADORA): si trip-service no responde, cae al default ESTÁTICO de código
 * `OPERABLE_VEHICLE_CLASSES` (hoy [CAR]) — ante incertidumbre se permite SOLO lo shippeado por defecto, no se abre a
 * MOTO especulativamente. NUNCA lanza (no rompe el matching por una config caída): warn + counter alertable.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { anonymousIdentity } from '@veo/auth';
import { InternalRestClient } from '@veo/rpc';
import {
  operableVehicleClasses,
  OPERABLE_VEHICLE_CLASSES,
  type VehicleClass,
} from '@veo/shared-types';
import { TRIP_REST } from '../infra/downstream.tokens';
import { bumpCatalogDegraded } from './dispatch.metrics';

/** Token DI (opcional) del TTL del cache; default 15s (el pool es hot-path, pero un TTL corto absorbe ráfagas). */
export const OPERABLE_CLASSES_CACHE_TTL_MS = Symbol('OPERABLE_CLASSES_CACHE_TTL_MS');

/** Forma MÍNIMA del catálogo efectivo: solo `enabled` + `vehicleClass` por oferta (el resto se ignora acá). */
interface CatalogReply {
  offerings: { enabled: boolean; vehicleClass: VehicleClass }[];
}

@Injectable()
export class OperableVehicleClassesProvider {
  private readonly logger = new Logger(OperableVehicleClassesProvider.name);
  /** Cache in-proc de un slot. SOLO lecturas exitosas; el fallback degradado NO se cachea (se reintenta). */
  private cache: { value: readonly VehicleClass[]; expiresAt: number } | null = null;

  constructor(
    @Inject(TRIP_REST) private readonly tripRest: InternalRestClient,
    @Optional()
    @Inject(OPERABLE_CLASSES_CACHE_TTL_MS)
    private readonly cacheTtlMs = 15_000,
  ) {}

  /**
   * Clases de vehículo operables AHORA según el catálogo efectivo del admin. Cacheado un slot (TTL corto);
   * degrada al default estático si trip-service no responde. Nunca lanza.
   */
  async get(): Promise<readonly VehicleClass[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    try {
      // Llamada de SISTEMA (sin usuario): identidad anónima firmada con `service-rail` (la audiencia la fija el
      // InternalRestClient). El endpoint solo verifica firma + audiencia; ignora el contenido de la identidad.
      const reply = await this.tripRest.get<CatalogReply>('/internal/catalog', {
        identity: anonymousIdentity('driver'),
      });
      const classes = operableVehicleClasses(reply.offerings);
      if (this.cacheTtlMs > 0) {
        this.cache = { value: classes, expiresAt: now + this.cacheTtlMs };
      }
      return classes;
    } catch (err) {
      this.logger.warn(
        `catálogo efectivo no disponible (${(err as Error).message}); filtro de clase operable cae al default ` +
          `estático OPERABLE_VEHICLE_CLASSES=[${OPERABLE_VEHICLE_CLASSES.join(',')}] (degradación conservadora)`,
      );
      bumpCatalogDegraded();
      return OPERABLE_VEHICLE_CLASSES;
    }
  }
}
