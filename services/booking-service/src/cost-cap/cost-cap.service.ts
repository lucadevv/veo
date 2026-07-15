/**
 * CostCapService — el GATE LEGAL F1b (cost-sharing por distancia, ADR-014 §8 · VEO_MODELO_HIBRIDO §8).
 * Orquesta el cálculo de distancias vía el PUERTO `MapsClient` (@veo/maps, INTEGRACIONES port+adapter — el
 * dominio NUNCA toca OSRM/HTTP) y aplica la MATEMÁTICA PURA del tope (`domain/cost-cap.ts`).
 *
 * Lo invoca published-trips.service en PUBLISH y en UPDATE (sobre el estado FINAL resultante), después de
 * los gates F1a (conductor + vehículo) y antes del assertTransition. Mismo contrato fail-closed que esos
 * gates: si el motor de rutas no responde, NO se publica/edita (mejor bloquear que validar mal el escudo legal).
 *
 * COSTO: full-route = 1 sola llamada `route` (con stopovers como waypoints). Por tramo = 1 llamada cada uno,
 * PARALELIZADAS con Promise.all (son pocas: ArrayMaxSize(40) en el DTO; publish NO es hot-path). No hay N+1
 * silencioso — el fan-out es acotado y explícito.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ExternalServiceError, ValidationError, type LatLon } from '@veo/utils';
import type { MapsClient } from '@veo/maps';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import { assertStopoverOrdersValid, destinoOrden } from '../domain/trip-segments';
import { assertAgreedPriceCap, assertFullRouteCap, assertTramoCap } from '../domain/cost-cap';
import { CostPerKmConfigService } from '../cost-per-km/cost-per-km-config.service';

/** Hito de la ruta con su orden y coordenadas (origen=0, stopovers=1..n, destino=destinoOrden). */
interface PuntoHito {
  orden: number;
  lat: number;
  lon: number;
}

/** Stopover tal como llega del DTO / persistido: coordenadas + orden. */
export interface StopoverPunto {
  lat: number;
  lon: number;
  orden: number;
}

/** Tramo de pricing a validar: factura [desdeOrden→hastaOrden] a `precioCentimos`. */
export interface TramoPrecio {
  desdeOrden: number;
  hastaOrden: number;
  precioCentimos: number;
}

/** Estado FINAL de la oferta sobre el que se valida el tope (publish: el DTO; update: DTO ∪ persistido). */
export interface PriceCapInput {
  pais: string;
  asientosTotales: number;
  precioBaseCentimos: number;
  /** Peaje del viaje declarado por el conductor (céntimos PEN). Sube SOLO el tope full-route (no los tramos). */
  tollsCents: number;
  origenLat: number;
  origenLon: number;
  destinoLat: number;
  destinoLon: number;
  stopovers: readonly StopoverPunto[];
  tramos: readonly TramoPrecio[];
}

/**
 * Input del re-tope F1b al RESERVAR (booking-service · escudo anti-lucro aplicado al `precioAcordado`). El
 * `stopovers` llega como el JSON PERSISTIDO de la oferta (no narrowado): se narrowea internamente a
 * {lat,lon,orden}[] para los waypoints del full-route (el caller — BookingsService — pasa `trip.stopovers` tal
 * cual). `precioAcordadoCentimos` es el monto POR ASIENTO (precioBase + specialRequest); el cobro total
 * (×asientos) lo arma el caller, NO este gate (el tope es por-asiento).
 */
export interface AgreedPriceCapInput {
  pais: string;
  asientosTotales: number;
  precioAcordadoCentimos: number;
  /** Peaje del viaje (céntimos PEN) declarado por el conductor al publicar; sube el tope full-route. */
  tollsCents: number;
  origenLat: number;
  origenLon: number;
  destinoLat: number;
  destinoLon: number;
  /** Stopovers PERSISTIDOS (Prisma.JsonValue de la oferta). Se narrowan internamente al shape {lat,lon,orden}[]. */
  stopovers: unknown;
}

@Injectable()
export class CostCapService {
  constructor(
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    // F2.5 · el costo/km lo fija el ADMIN por país (CostPerKmConfig en DB), NO se deriva de energía. El
    // servicio degrada al env COST_PER_KM_CENTS_* si la config no está disponible (degradación honesta) —
    // el gate F1b nunca se queda sin costo/km. La FÓRMULA del tope vive en el dominio puro (cost-cap.ts).
    private readonly costPerKm: CostPerKmConfigService,
  ) {}

  /**
   * GATE F1b. Calcula la distancia real (vía el puerto de mapas) y exige que `precioBase` (full-route, con el
   * peaje sumado) y CADA `precioPorTramo` (distancia pura) no excedan su tope. Cualquier exceso →
   * ValidationError (de las funciones puras). FAIL-CLOSED: si el motor de rutas falla (red/timeout/sin ruta),
   * lanza ExternalServiceError y NO se publica/edita — el tope legal no se puede saltar por infraestructura.
   */
  async assertPriceCap(input: PriceCapInput): Promise<void> {
    // F2.5 · el costo/km sale DIRECTO de la config del admin (per-país), con degradación honesta al env.
    const costPerKmCents = await this.costPerKm.getCostPerKmCents(input.pais);

    // Mapa orden→punto: origen=0, stopovers por su `orden`, destino=destinoOrden (fuente única, F1a).
    const puntosPorOrden = this.buildPuntosPorOrden(input);

    // FULL-ROUTE — 1 sola llamada: origen → destino con los stopovers (en orden) como waypoints.
    const fullRoute = await this.fullRouteDistanceMeters(input);
    // El peaje declarado SUBE el tope full-route (costo del viaje entero ÷ asientos).
    assertFullRouteCap({
      precioBaseCentimos: input.precioBaseCentimos,
      distanceMeters: fullRoute,
      costPerKmCents,
      asientosTotales: input.asientosTotales,
      tollsCents: input.tollsCents,
    });

    // Orden del destino (origen=0, destino=max(stopovers.orden)+1). Sirve para decidir si un tramo ABARCA el
    // viaje completo (origen→destino) y por ende carga el peaje, o es un sub-segmento estricto (sin peaje).
    const ordenDestino = destinoOrden(input.stopovers);

    // POR TRAMO — paralelizadas (Promise.all). Cada tramo: ruta entre sus hitos extremos, con los stopovers
    // intermedios que caen ESTRICTAMENTE dentro del rango como waypoints (la distancia del segmento real).
    await Promise.all(
      input.tramos.map(async (tramo) => {
        const desde = this.requirePunto(puntosPorOrden, tramo.desdeOrden);
        const hasta = this.requirePunto(puntosPorOrden, tramo.hastaOrden);
        const intermedios = [...puntosPorOrden.values()]
          .filter((p) => p.orden > tramo.desdeOrden && p.orden < tramo.hastaOrden)
          .sort((a, b) => a.orden - b.orden)
          .map<LatLon>((p) => ({ lat: p.lat, lon: p.lon }));

        const distTramo = await this.routeOrFailClosed(
          { lat: desde.lat, lon: desde.lon },
          { lat: hasta.lat, lon: hasta.lon },
          intermedios,
        );
        // El peaje entra SOLO si el tramo abarca la ruta completa (origen → destino): ese tramo ES el viaje
        // entero (el tramo full-route implícito == precioBase), así que carga el peaje igual que el full-route.
        // Un sub-segmento estricto NO lo carga (sumarle el peaje de todo el viaje inflaría su tope → lucro).
        const esRutaCompleta = tramo.desdeOrden === 0 && tramo.hastaOrden === ordenDestino;
        assertTramoCap({
          desdeOrden: tramo.desdeOrden,
          hastaOrden: tramo.hastaOrden,
          precioCentimos: tramo.precioCentimos,
          distanceMeters: distTramo,
          costPerKmCents,
          asientosTotales: input.asientosTotales,
          tollsCents: esRutaCompleta ? input.tollsCents : 0,
        });
      }),
    );
  }

  /**
   * RE-TOPE F1b AL RESERVAR (booking-service · escudo anti-lucro aplicado al `precioAcordado`). Recomputa el
   * tope FULL-ROUTE de una oferta YA PUBLICADA (mismo costo/km del admin + peaje + asientos que el publish) y
   * exige que `precioAcordadoCentimos` (= precioBase + specialRequest, POR ASIENTO) no lo exceda. El conductor
   * NO puede recibir, por asiento, más que el costo compartido topado — ni siquiera vía el `specialRequest` que
   * el pasajero suma al reservar (que al publicar NO se topa, porque no existe aún). FAIL-CLOSED igual que el
   * publish: si el motor de rutas no responde, NO se reserva (el tope legal no se salta por infraestructura).
   *
   * SOLO el caller que tiene un specialRequest > 0 necesita llamar acá: si specialRequest es 0, precioAcordado
   * == precioBase, que YA fue topado al publicar (invariante) → no hace falta re-pegarle a mapas (el caller
   * decide, espejo de `editTouchesPriceCap`). El cobro total (precioAcordado × asientos) lo arma el caller.
   */
  async assertAgreedPriceWithinCap(input: AgreedPriceCapInput): Promise<void> {
    // El costo/km sale DIRECTO de la config del admin (per-país), con degradación honesta al env (idéntico al publish).
    const costPerKmCents = await this.costPerKm.getCostPerKmCents(input.pais);
    const distanceMeters = await this.fullRouteDistanceMeters({
      origenLat: input.origenLat,
      origenLon: input.origenLon,
      destinoLat: input.destinoLat,
      destinoLon: input.destinoLon,
      // Stopovers persistidos (JSON) → shape {lat,lon,orden}[] para los waypoints del full-route.
      stopovers: readStopoverPuntos(input.stopovers),
    });
    // El peaje del viaje SUBE el tope full-route (costo del viaje entero ÷ asientos), igual que en el publish.
    assertAgreedPriceCap({
      precioAcordadoCentimos: input.precioAcordadoCentimos,
      distanceMeters,
      costPerKmCents,
      asientosTotales: input.asientosTotales,
      tollsCents: input.tollsCents,
    });
  }

  /**
   * Distancia FULL-ROUTE (metros) de una ruta origen → destino con los stopovers (en orden) como waypoints —
   * UNA sola llamada al puerto de mapas. FUENTE ÚNICA de la distancia full-route: la comparten el gate de
   * publish/edit (`assertPriceCap`) y el re-tope al reservar (`assertAgreedPriceWithinCap`) → cero drift. El
   * fail-closed lo hereda de `routeOrFailClosed` (motor caído → ExternalServiceError, nunca un default).
   */
  private async fullRouteDistanceMeters(input: {
    origenLat: number;
    origenLon: number;
    destinoLat: number;
    destinoLon: number;
    stopovers: readonly StopoverPunto[];
  }): Promise<number> {
    const origen: LatLon = { lat: input.origenLat, lon: input.origenLon };
    const destino: LatLon = { lat: input.destinoLat, lon: input.destinoLon };
    const waypointsFull = [...input.stopovers]
      .sort((a, b) => a.orden - b.orden)
      .map<LatLon>((s) => ({ lat: s.lat, lon: s.lon }));
    return this.routeOrFailClosed(origen, destino, waypointsFull);
  }

  /**
   * Construye el mapa orden→{lat,lon}: origen(0) ∪ stopovers(orden) ∪ destino(destinoOrden).
   *
   * FAIL-CLOSED (defensa en profundidad, espeja el borde DTO): ANTES de construir el Map se enforça el
   * invariante de hitos (`assertStopoverOrdersValid`) — stopovers en {1..n} únicos, ninguno en 0 (origen) ni
   * ≥ n+1 (destino). Sin esto, un `map.set(s.orden, …)` colisionante haría LAST-WRITE-WINS silencioso: un
   * stopover en orden 0 SOBREESCRIBIRÍA el origen, dos con el mismo orden se pisarían, uno en `destinoOrden`
   * pisaría el destino → distancia de tramo inflada → tope inflado → lucro. Además, tras setear cada hito se
   * verifica que NINGÚN punto previo sea sobreescrito (guard explícito anti last-write-wins): origen(0),
   * stopovers(1..n) y destino(n+1) ocupan claves disjuntas; cualquier colisión es un estado inválido → throw.
   */
  private buildPuntosPorOrden(input: PriceCapInput): Map<number, PuntoHito> {
    // Invariante de hitos en el borde del dominio: stopovers = {1..n} únicos, disjuntos de origen(0)/destino.
    assertStopoverOrdersValid(input.stopovers);

    const map = new Map<number, PuntoHito>();
    this.setHitoOrFail(map, 0, { orden: 0, lat: input.origenLat, lon: input.origenLon });
    for (const s of input.stopovers) {
      this.setHitoOrFail(map, s.orden, { orden: s.orden, lat: s.lat, lon: s.lon });
    }
    const ordenDestino = destinoOrden(input.stopovers);
    this.setHitoOrFail(map, ordenDestino, {
      orden: ordenDestino,
      lat: input.destinoLat,
      lon: input.destinoLon,
    });
    return map;
  }

  /**
   * Inserta un hito en el Map FALLANDO si la clave ya está ocupada (NUNCA last-write-wins silencioso). El
   * invariante de hitos es: origen(0), stopovers(1..n únicos), destino(n+1) ocupan claves DISJUNTAS. Una
   * colisión acá es un estado de dominio inválido (un stopover pisando origen/destino/otro stopover) → throw.
   */
  private setHitoOrFail(map: Map<number, PuntoHito>, orden: number, hito: PuntoHito): void {
    if (map.has(orden)) {
      throw new ValidationError(
        'Colisión de orden entre hitos de la ruta (origen/stopovers/destino)',
        {
          orden,
        },
      );
    }
    map.set(orden, hito);
  }

  /**
   * Resuelve el punto de un orden o lanza. La integridad referencial (tramo→hito existente) ya la valida
   * `assertTramosReferToValidStopovers` ANTES de llamar acá; este require es defensa en profundidad (un
   * orden sin punto sería un bug de modelo, no un input legítimo) → ExternalServiceError mejor que `any`/undefined.
   */
  private requirePunto(map: Map<number, PuntoHito>, orden: number): PuntoHito {
    const punto = map.get(orden);
    if (!punto) {
      throw new ExternalServiceError(
        'No se pudo resolver el hito del tramo para calcular su distancia',
        {
          orden,
        },
      );
    }
    return punto;
  }

  /**
   * Llama al puerto de mapas y devuelve la distancia en metros. FAIL-CLOSED: cualquier falla del motor
   * (red, timeout, OSRM sin ruta — ya viene como ExternalServiceError de @veo/maps, pero re-envolvemos toda
   * excepción) se traduce a ExternalServiceError con un mensaje accionable. NO devuelve un default → el
   * gate no se puede saltar por infraestructura caída.
   */
  private async routeOrFailClosed(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[],
  ): Promise<number> {
    try {
      const result = await this.maps.route(origin, destination, waypoints);
      return result.distanceMeters;
    } catch (err) {
      throw new ExternalServiceError(
        'No pudimos calcular la distancia de la ruta para validar el precio. Intentá de nuevo.',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

/**
 * Narrowing TIPADO del `stopovers` JSON persistido (Prisma.JsonValue) al shape COMPLETO `{lat,lon,orden}[]` que
 * el cálculo del full-route necesita (coordenadas + orden, para los waypoints). Tolerante a filas legacy /
 * datos sucios: descarta entradas que no traen los tres números (no rompe el gate con basura; el invariante se
 * evalúa sobre lo bien formado). Espeja `readStopoverPuntos` de published-trips.service (mismo criterio).
 */
function readStopoverPuntos(value: unknown): StopoverPunto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.lat === 'number' &&
    typeof entry.lon === 'number' &&
    typeof entry.orden === 'number'
      ? [{ lat: entry.lat, lon: entry.lon, orden: entry.orden }]
      : [],
  );
}

/** Type-guard mínimo: ¿`value` es un objeto plano indexable? (evita `any`, narrowing seguro del JSON). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
