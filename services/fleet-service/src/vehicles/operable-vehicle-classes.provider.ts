/**
 * OperableVehicleClassesProvider — resuelve las CLASES de vehículo operables HOY desde el catálogo
 * EFECTIVO del admin (base ⟕ overlay runtime), no desde la constante estática de código. Es la pieza que
 * hace overlay-aware al gate de operabilidad del alta (`VehiclesService.assertOperableVehicleType`): si el
 * admin habilita una oferta MOTO por overlay, el alta del conductor deja de bloquear MOTO sin tocar código.
 *
 * Lee `GET /internal/catalog` de trip-service (la MISMA fuente que el quote/createTrip ya consumen) por el
 * cliente REST interno firmado (audiencia `service-rail`, llamada de sistema sin usuario) y deriva el set con
 * el helper PURO `operableVehicleClasses` de @veo/shared-types (DRY con el default estático).
 *
 * CACHE in-proc de un slot (TTL corto): el alta NO es hot-path, pero un alta hace varias y un TTL de ~15s
 * absorbe ráfagas del onboarding sin atar el gate al lag de un cambio de overlay del admin.
 *
 * DEGRADACIÓN HONESTA (dirección CONSERVADORA): si trip-service no responde, se cae al default ESTÁTICO de
 * código `OPERABLE_VEHICLE_CLASSES` (hoy [CAR]) — ante incertidumbre se permite SOLO lo que el código
 * shippeó por defecto, NO se abre a MOTO especulativamente. Nunca se crashea el alta por una config caída:
 * un trip-service caído no debe impedir registrar un auto. Se loguea warn + se bumpea el counter de
 * degradación (alertable para Ops).
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
import { bumpCatalogDegraded } from './fleet-catalog-metrics';

/** Token DI (opcional) del TTL del cache; default 15s si el módulo no lo provee (alta no es hot-path). */
export const OPERABLE_CLASSES_CACHE_TTL_MS = Symbol('OPERABLE_CLASSES_CACHE_TTL_MS');

/**
 * Forma MÍNIMA del catálogo efectivo que este provider consume del GET /internal/catalog (mismo endpoint
 * que el public-bff). Solo nos importan `enabled` + `vehicleClass` por oferta para derivar el set de clases;
 * el resto del payload (pricing/modePin/labelKey…) se ignora acá.
 */
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
   * degrada al default estático si trip-service no responde (ver doc de clase). Nunca lanza.
   */
  async get(): Promise<readonly VehicleClass[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    try {
      // Llamada de SISTEMA (sin usuario): identidad anónima de tipo 'driver' firmada con `service-rail`
      // (la audiencia la fija el InternalRestClient en su construcción). El endpoint solo verifica firma
      // HMAC + audiencia; ignora el contenido de la identidad (es una lectura de config).
      const reply = await this.tripRest.get<CatalogReply>('/internal/catalog', {
        identity: anonymousIdentity('driver'),
      });
      const classes = operableVehicleClasses(reply.offerings);
      if (this.cacheTtlMs > 0) {
        this.cache = { value: classes, expiresAt: now + this.cacheTtlMs };
      }
      return classes;
    } catch (err) {
      // DEGRADACIÓN HONESTA conservadora: ante un trip-service caído, el alta NO se crashea — se cae al
      // default estático de código (solo lo shippeado por defecto). No abrimos a MOTO especulativamente.
      this.logger.warn(
        `catálogo efectivo no disponible (${(err as Error).message}); gate de operabilidad cae al default ` +
          `estático OPERABLE_VEHICLE_CLASSES=[${OPERABLE_VEHICLE_CLASSES.join(',')}] (degradación honesta)`,
      );
      bumpCatalogDegraded('operable_classes');
      return OPERABLE_VEHICLE_CLASSES;
    }
  }
}
