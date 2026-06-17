import type {GeoPoint} from '@veo/api-client';
import type {NearbyVehicleType} from '../../../dispatch/domain/dispatchRepository';
import type {TripPhase} from './tripFlowPhase';

/**
 * COREOGRAFÍA DEL MAPA POR FASE — helper PURO (sin React, sin efectos) que decide, para cada fase del
 * viaje, QUÉ markers muestra el mapa y CÓMO encuadra la cámara. Es la única fuente de verdad de la
 * "dirección de cámara": `RequestFlowScreen` lo invoca y baja props simples al `AppMap`
 * (`showUserPoint`, `cameraTarget`, …), de modo que el `AppMap` NO contiene `if`s de fase.
 *
 * Por qué un helper puro y no lógica esparcida: el update de ubicación del conductor llega seguido (cada
 * pocos cientos de ms); concentrar la decisión en una función testeable evita que cada fase reinvente el
 * encuadre y permite cubrir las fases REALES del repo con un test unitario.
 */

const isValidPoint = (p: GeoPoint | null | undefined): p is GeoPoint =>
  p != null &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lon) &&
  !(p.lat === 0 && p.lon === 0);

/**
 * Modo de cámara que el `AppMap` debe aplicar:
 *  - `fit`    → encuadrar un conjunto de puntos con `fitBounds` (padding generoso). Pre-pickup
 *               (conductor + recogida) y ruta normal.
 *  - `follow` → seguir un único punto (centro estable + zoom fijo). Viaje en curso siguiendo al taxi.
 *  - `center` → centro simple sin animación de seguimiento (home idle).
 */
export type CameraMode = 'fit' | 'follow' | 'center';

/** Objetivo declarativo de cámara que produce el director para que el `AppMap` lo materialice. */
export interface CameraTarget {
  mode: CameraMode;
  /** Puntos a contener (modo `fit`). Vacío si no aplica. */
  fitPoints: GeoPoint[];
  /** Punto a seguir (modo `follow`/`center`). `null` si no aplica. */
  followPoint: GeoPoint | null;
  /** Zoom para `follow`/`center` (en `fit` lo decide el bounds). */
  followZoom?: number;
}

/** Resultado del director: props simples y declarativas para el `AppMap`. */
export interface MapDirective {
  /** Pinta el punto de MI ubicación (halo lima). Falso en viaje en curso: el pasajero VA en el taxi. */
  showUserPoint: boolean;
  /** Pinta el AMBIENTE (autitos cercanos anónimos). Solo home/búsqueda/cierre. */
  showNearby: boolean;
  /** Pinta el marker del conductor asignado como VehicleIcon (en vez del pin genérico). */
  showDriverVehicle: boolean;
  /**
   * Objetivo de cámara DIRIGIDO, o `null` cuando NO hay nada concreto que dirigir (sin conductor, sin
   * userPoint, fase de ruta…). `null` es la SEÑAL para que el `AppMap` use su `Camera` DECLARATIVA (fit
   * de ruta / center con `bottomInset`) — la que SÍ encuadra. Antes devolvíamos un `fit` con `fitPoints:[]`
   * o un `center`/`follow` con punto nulo: la `Camera` dirigida montada NO hacía nada (no-op) y la cámara
   * DERIVABA al zoom-ciudad por `defaultSettings` en cada ciclo ("se aleja más y más"). Ver F3 en REPORTE.
   */
  cameraTarget: CameraTarget | null;
}

/**
 * Zoom estable al seguir al taxi en viaje en curso. Calibración de GUSTO del dueño: "sentirme MÁS encima
 * de la acción". Probado 16.2 / 16.3 / 16.5: a 16.5 ya se siente nivel-puerta y el taxi llena de más; a
 * 16.2 todavía respira ciudad. 16.3 es el punto dulce — ves la cuadra inmediata y el taxi domina sin
 * marear ni perder contexto de la esquina siguiente. Sube desde 15.5 (encuadre anterior, más lejano).
 */
export const FOLLOW_ZOOM = 16.3;

/** Entrada del director (todos los puntos que conoce la pantalla en el frame actual). */
export interface MapDirectorInput {
  phase: TripPhase;
  /** Ubicación en vivo del conductor (socket). `null` mientras no llega el primer fix. */
  driver: GeoPoint | null;
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  userPoint: GeoPoint | null;
  /** Tipo de vehículo del trip si se conoce (hoy NO viene en TripActiveView → CAR por defecto). */
  vehicleType?: NearbyVehicleType;
  /** Hay geometría de ruta dibujada (para el `fit` normal de la fase route). */
  hasRoute: boolean;
}

/**
 * Decide la coreografía del mapa para la fase actual. PURA.
 *
 *  PRE-PICKUP (enRoute/arrived): encuadre [conductor live + recogida]. Al acercarse el vehículo al
 *    origen, el bounding box se achica solo → la cámara "se cierra" sin lógica extra (es geometría). Si
 *    aún no hay ubicación del conductor → fallback al fit de ruta/origen (comportamiento previo).
 *  IN PROGRESS: SOLO el taxi (sin userPoint). Cámara en modo `follow` sobre el conductor con zoom
 *    estable; la ruta al destino sigue dibujada. (Se eligió follow sobre fit[veh+dest] para que el zoom
 *    no "respire" en cada update y se sienta calmo a 60fps — ver REPORTE.)
 *  COMPLETED: vuelven userPoint + nearbyVehicles (ambiente); cámara vuelve al encuadre del cierre.
 */
export function resolveMapDirective(input: MapDirectorInput): MapDirective {
  // `destination`/`userPoint`/`hasRoute` ya NO se usan en la decisión de cámara: las fases que antes los
  // necesitaban (fallbacks/center) ahora devuelven `cameraTarget: null` y delegan el encuadre a la Camera
  // declarativa del AppMap (que lee la ruta/markers/userPoint por su cuenta). Se conservan en el input
  // (el caller los pasa) pero no se desestructuran acá.
  const {phase, driver, origin} = input;
  const driverPt = isValidPoint(driver) ? driver : null;
  const originPt = isValidPoint(origin) ? origin : null;

  switch (phase) {
    case 'enRoute':
    case 'arrived': {
      // DIRIGE sólo si hay conductor: encuadre [conductor + recogida]. En 'arrived' el conductor ya está
      // sobre el origen → el box es chico → encuadre cerrado sobre la recogida con el vehículo,
      // naturalmente. SIN conductor no hay nada concreto que dirigir → `null` → la Camera DECLARATIVA del
      // AppMap encuadra la ruta/markers (el fallback de antes lo hacía la dirigida con un fit que, si
      // origin/dest faltaban, quedaba vacío y derivaba a zoom-ciudad).
      if (driverPt) {
        const fitPoints = originPt ? [driverPt, originPt] : [driverPt];
        return {
          showUserPoint: false,
          showNearby: false,
          showDriverVehicle: true,
          cameraTarget: {mode: 'fit', fitPoints, followPoint: null},
        };
      }
      return {
        showUserPoint: false,
        showNearby: false,
        showDriverVehicle: false,
        cameraTarget: null,
      };
    }

    case 'inProgress': {
      // SOLO el taxi: ocultamos MI ubicación (ruido, voy adentro). DIRIGE sólo si hay conductor: sigo al
      // vehículo con zoom estable (la ruta al destino sigue dibujada). SIN conductor → `null` → la Camera
      // declarativa encuadra la ruta.
      return {
        showUserPoint: false,
        showNearby: false,
        showDriverVehicle: true,
        cameraTarget: driverPt
          ? {
              mode: 'follow',
              fitPoints: [],
              followPoint: driverPt,
              followZoom: FOLLOW_ZOOM,
            }
          : null,
      };
    }

    case 'completed':
    case 'idle':
    case 'ended': {
      // Cierre/home/terminal: vuelve el userPoint y el ambiente. NO dirigimos: el encuadre sobre MI
      // ubicación (con la reserva del sheet) lo hace la Camera declarativa del AppMap por `center` +
      // `bottomInset` — idéntico resultado que el `center` dirigido, sin riesgo de no-op si falta el punto.
      return {
        showUserPoint: true,
        showNearby: true,
        showDriverVehicle: false,
        cameraTarget: null,
      };
    }

    // Fases de cotización/puja (route): ruta dibujada, sin conductor, sin ambiente (salvo searching, que
    // lo decide la pantalla). NUNCA dirigimos acá → `null` → la Camera declarativa encuadra la ruta/markers
    // (`fitToRoute`). Antes devolvíamos un `fit` con `fitPoints:[]` que montaba la Camera dirigida y la
    // dejaba sin encuadrar → derivaba al zoom-ciudad ("se aleja más y más" en los reintentos).
    case 'quoting':
    case 'searching':
    case 'offers':
    case 'noOffers':
    case 'reassigning':
    default: {
      return {
        showUserPoint: false,
        // El ambiente en searching lo sigue gateando la pantalla (no es responsabilidad de la cámara).
        showNearby: phase === 'searching',
        showDriverVehicle: false,
        cameraTarget: null,
      };
    }
  }
}
