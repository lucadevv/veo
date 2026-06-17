import {
  MAX_WAYPOINTS,
  isWaypointSet,
  type RoutePlace,
} from '../src/features/maps/domain/entities';
import {useRideDraftStore} from '../src/features/maps/presentation/stores/rideDraftStore';

function place(title: string, lat = -12.05, lng = -77.04): RoutePlace {
  return {point: {lat, lng}, title};
}

describe('rideDraftStore · paradas múltiples (waypoints)', () => {
  beforeEach(() => {
    useRideDraftStore.getState().reset();
  });

  it('inicia sin paradas y editando el destino', () => {
    const state = useRideDraftStore.getState();
    expect(state.waypoints).toEqual([]);
    expect(state.editing).toEqual({kind: 'destination'});
  });

  it('agrega un marcador vacío y lo deja en edición', () => {
    useRideDraftStore.getState().addWaypoint();
    const state = useRideDraftStore.getState();
    expect(state.waypoints).toHaveLength(1);
    expect(isWaypointSet(state.waypoints[0])).toBe(false);
    expect(state.editing).toEqual({kind: 'waypoint', index: 0});
  });

  it('fija la dirección de una parada por índice', () => {
    const store = useRideDraftStore.getState();
    store.addWaypoint();
    store.setWaypoint(0, place('Plaza San Martín'));
    const wp = useRideDraftStore.getState().waypoints;
    expect(wp[0].title).toBe('Plaza San Martín');
    expect(isWaypointSet(wp[0])).toBe(true);
  });

  it('no permite más paradas que el máximo del contrato', () => {
    const store = useRideDraftStore.getState();
    for (let i = 0; i < MAX_WAYPOINTS + 2; i += 1) {
      useRideDraftStore.getState().addWaypoint();
    }
    expect(useRideDraftStore.getState().waypoints).toHaveLength(MAX_WAYPOINTS);
    void store;
  });

  it('quita una parada por índice y conserva el orden', () => {
    const store = useRideDraftStore.getState();
    store.addWaypoint();
    useRideDraftStore.getState().setWaypoint(0, place('A'));
    useRideDraftStore.getState().addWaypoint();
    useRideDraftStore.getState().setWaypoint(1, place('B'));
    useRideDraftStore.getState().removeWaypoint(0);
    const wp = useRideDraftStore.getState().waypoints;
    expect(wp).toHaveLength(1);
    expect(wp[0].title).toBe('B');
  });

  it('reset limpia origen, destino y paradas', () => {
    const store = useRideDraftStore.getState();
    store.setOrigin(place('Origen'));
    store.setDestination(place('Destino'));
    useRideDraftStore.getState().addWaypoint();
    useRideDraftStore.getState().reset();
    const state = useRideDraftStore.getState();
    expect(state.origin).toBeNull();
    expect(state.destination).toBeNull();
    expect(state.waypoints).toEqual([]);
  });
});
