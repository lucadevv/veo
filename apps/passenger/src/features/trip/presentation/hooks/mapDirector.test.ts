import type {GeoPoint} from '@veo/api-client';
import {
  ARRIVED_ZOOM,
  FOLLOW_PITCH,
  FOLLOW_ZOOM,
  resolveMapDirective,
  type MapDirectorInput,
} from './mapDirector';
import type {TripPhase} from './tripFlowPhase';

const driver: GeoPoint = {lat: -12.05, lon: -77.04};
const origin: GeoPoint = {lat: -12.06, lon: -77.05};
const destination: GeoPoint = {lat: -12.1, lon: -77.0};
const user: GeoPoint = {lat: -12.04, lon: -77.03};

const base: MapDirectorInput = {
  phase: 'idle',
  driver: null,
  origin,
  destination,
  userPoint: user,
  hasRoute: false,
};

/**
 * INVARIANTE F3: el director SÓLO devuelve un `cameraTarget` cuando hay algo CONCRETO que dirigir
 * (pre-pickup con conductor → fit [conductor+recogida]; en curso con conductor → follow). En TODO otro
 * caso `cameraTarget` es `null` → el AppMap usa su Camera DECLARATIVA (fit de ruta / center) que SÍ
 * encuadra, en vez de montar una Camera dirigida que no hace nada y deja la cámara derivar al zoom-ciudad.
 */
describe('resolveMapDirective', () => {
  describe('conductor viniendo (enRoute)', () => {
    it('CON conductor → fit [conductor + recogida] (JAMÁS el destino), taxi visible, sin userPoint', () => {
      const d = resolveMapDirective({...base, phase: 'enRoute', driver});
      expect(d.showDriverVehicle).toBe(true);
      expect(d.showUserPoint).toBe(false);
      expect(d.cameraTarget).not.toBeNull();
      expect(d.cameraTarget?.mode).toBe('fit');
      expect(d.cameraTarget?.fitPoints).toEqual([driver, origin]);
    });

    it('SIN conductor → cameraTarget NULL (la Camera declarativa encuadra ruta/markers), sin taxi', () => {
      const d = resolveMapDirective({...base, phase: 'enRoute', driver: null});
      expect(d.showDriverVehicle).toBe(false);
      expect(d.cameraTarget).toBeNull();
    });
  });

  describe('tu conductor llegó (arrived)', () => {
    it('zoom CERRADO sobre la recogida (center determinista ARRIVED_ZOOM, norte-arriba, sin pitch)', () => {
      const d = resolveMapDirective({...base, phase: 'arrived', driver});
      expect(d.showDriverVehicle).toBe(true);
      expect(d.showUserPoint).toBe(false);
      expect(d.cameraTarget?.mode).toBe('follow');
      expect(d.cameraTarget?.followPoint).toEqual(origin);
      expect(d.cameraTarget?.followZoom).toBe(ARRIVED_ZOOM);
      // Parado esperando el auto: nada de vista de manejo (el aplicador resetea a cenital/norte).
      expect(d.cameraTarget?.followPitch).toBeUndefined();
      expect(d.cameraTarget?.followHeading).toBeUndefined();
    });

    it('sin origen cae al conductor como punto de encuentro (mismo zoom cerrado)', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'arrived',
        driver,
        origin: null,
      });
      expect(d.cameraTarget?.followPoint).toEqual(driver);
      expect(d.cameraTarget?.followZoom).toBe(ARRIVED_ZOOM);
    });

    it('sin origen NI conductor → cameraTarget NULL (Camera declarativa), sin taxi', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'arrived',
        driver: null,
        origin: null,
      });
      expect(d.showDriverVehicle).toBe(false);
      expect(d.cameraTarget).toBeNull();
    });
  });

  describe('inProgress (viaje en curso)', () => {
    it('oculta userPoint, muestra solo el taxi y sigue al vehículo con zoom estable', () => {
      const d = resolveMapDirective({...base, phase: 'inProgress', driver});
      expect(d.showUserPoint).toBe(false);
      expect(d.showNearby).toBe(false);
      expect(d.showDriverVehicle).toBe(true);
      expect(d.cameraTarget?.mode).toBe('follow');
      expect(d.cameraTarget?.followPoint).toEqual(driver);
      expect(d.cameraTarget?.followZoom).toBe(FOLLOW_ZOOM);
    });

    it('vista "como si manejara": follow con pitch suave + bearing = heading del conductor', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'inProgress',
        driver,
        driverHeading: 137,
      });
      expect(d.cameraTarget?.followPitch).toBe(FOLLOW_PITCH);
      expect(d.cameraTarget?.followHeading).toBe(137);
    });

    it('heading null/no finito → followHeading null (el aplicador retiene el último válido; jamás 0°)', () => {
      const withoutHeading = resolveMapDirective({
        ...base,
        phase: 'inProgress',
        driver,
        driverHeading: null,
      });
      expect(withoutHeading.cameraTarget?.followHeading).toBeNull();
      const nanHeading = resolveMapDirective({
        ...base,
        phase: 'inProgress',
        driver,
        driverHeading: NaN,
      });
      expect(nanHeading.cameraTarget?.followHeading).toBeNull();
    });

    it('pre-pickup (enRoute) NO usa la vista de manejo: fit norte-arriba sin pitch/heading', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'enRoute',
        driver,
        driverHeading: 90,
      });
      expect(d.cameraTarget?.mode).toBe('fit');
      expect(d.cameraTarget?.followPitch).toBeUndefined();
      expect(d.cameraTarget?.followHeading).toBeUndefined();
    });

    it('SIN conductor → cameraTarget NULL (la Camera declarativa encuadra la ruta), taxi aún flagueado', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'inProgress',
        driver: null,
      });
      expect(d.cameraTarget).toBeNull();
    });
  });

  describe('completed (cierre)', () => {
    it('vuelve el userPoint y el ambiente; NO dirige (cameraTarget null → center declarativo)', () => {
      const d = resolveMapDirective({...base, phase: 'completed', driver});
      expect(d.showUserPoint).toBe(true);
      expect(d.showNearby).toBe(true);
      expect(d.showDriverVehicle).toBe(false);
      expect(d.cameraTarget).toBeNull();
    });
  });

  describe('idle / fases de ruta', () => {
    it('idle muestra userPoint + ambiente y NO dirige (cameraTarget null)', () => {
      const d = resolveMapDirective({...base, phase: 'idle'});
      expect(d.showUserPoint).toBe(true);
      expect(d.showNearby).toBe(true);
      expect(d.cameraTarget).toBeNull();
    });

    it('ended NO dirige (cameraTarget null), muestra userPoint + ambiente', () => {
      const d = resolveMapDirective({...base, phase: 'ended'});
      expect(d.showUserPoint).toBe(true);
      expect(d.showNearby).toBe(true);
      expect(d.cameraTarget).toBeNull();
    });

    it('searching muestra ambiente pero NO userPoint y NO dirige (cameraTarget null)', () => {
      const d = resolveMapDirective({...base, phase: 'searching'});
      expect(d.showNearby).toBe(true);
      expect(d.showUserPoint).toBe(false);
      expect(d.cameraTarget).toBeNull();
    });

    it('quoting/offers/noOffers/reassigning: sin ambiente, sin taxi, cameraTarget null (Camera declarativa)', () => {
      for (const phase of [
        'quoting',
        'offers',
        'noOffers',
        'reassigning',
      ] as TripPhase[]) {
        const d = resolveMapDirective({...base, phase});
        expect(d.showNearby).toBe(false);
        expect(d.showDriverVehicle).toBe(false);
        expect(d.cameraTarget).toBeNull();
      }
    });

    it('con ruta dibujada las fases de ruta siguen sin dirigir (cameraTarget null)', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'quoting',
        hasRoute: true,
      });
      expect(d.cameraTarget).toBeNull();
    });
  });

  describe('casos borde de coordenadas', () => {
    it('ignora (0,0) como ubicación del conductor → cae al fallback (cameraTarget null)', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'enRoute',
        driver: {lat: 0, lon: 0},
      });
      expect(d.showDriverVehicle).toBe(false);
      expect(d.cameraTarget).toBeNull();
    });

    it('ignora coordenadas no finitas (NaN) del conductor → sin follow (cameraTarget null)', () => {
      const d = resolveMapDirective({
        ...base,
        phase: 'inProgress',
        driver: {lat: NaN, lon: -77},
      });
      expect(d.showDriverVehicle).toBe(true);
      // sin driver válido → no dirige
      expect(d.cameraTarget).toBeNull();
    });
  });
});
