import {create} from 'zustand';
import type {RoutePlace} from '../../domain/entities';
import {MAX_WAYPOINTS} from '../../domain/entities';

/**
 * Qué punto del trayecto edita el buscador. Además de origen y destino, puede editar una PARADA
 * intermedia por índice (Ola 2B · paradas múltiples).
 */
export type RouteEndpointKind =
  | {kind: 'origin'}
  | {kind: 'destination'}
  | {kind: 'waypoint'; index: number};

export interface RideDraftState {
  /** Origen elegido (por defecto se siembra con la ubicación actual). */
  origin: RoutePlace | null;
  /** Destino elegido. */
  destination: RoutePlace | null;
  /** Paradas intermedias ordenadas (máx `MAX_WAYPOINTS`). */
  waypoints: RoutePlace[];
  /** Punto en edición en la pantalla de búsqueda. */
  editing: RouteEndpointKind;

  setOrigin: (place: RoutePlace | null) => void;
  setDestination: (place: RoutePlace | null) => void;
  setEditing: (target: RouteEndpointKind) => void;
  /** Inserta una parada vacía al final (si no se alcanzó el máximo) y la deja en edición. */
  addWaypoint: () => void;
  /** Fija el lugar de la parada en `index`. */
  setWaypoint: (index: number, place: RoutePlace) => void;
  /** Quita la parada en `index`. */
  removeWaypoint: (index: number) => void;
  /** Intercambia origen y destino. */
  swap: () => void;
  /** Limpia el borrador (al volver al Home o tras confirmar). */
  reset: () => void;
}

/**
 * Borrador del viaje a pedir (estado de cliente puro, Zustand). Vive entre Home → Búsqueda →
 * Ruta/cotización sin pasar params frágiles por navegación. NO contiene lógica de negocio: solo
 * el origen/destino elegidos y qué campo se edita. La cotización (estado de servidor) la maneja
 * React Query en la pantalla de ruta.
 */
export const useRideDraftStore = create<RideDraftState>(set => ({
  origin: null,
  destination: null,
  waypoints: [],
  editing: {kind: 'destination'},

  setOrigin: origin => set({origin}),
  setDestination: destination => set({destination}),
  setEditing: editing => set({editing}),

  addWaypoint: () =>
    set(state => {
      if (state.waypoints.length >= MAX_WAYPOINTS) {
        return state;
      }
      const index = state.waypoints.length;
      // Marcador vacío hasta que el buscador fije la dirección; queda en edición.
      const placeholder: RoutePlace = {point: {lat: 0, lng: 0}, title: ''};
      return {
        waypoints: [...state.waypoints, placeholder],
        editing: {kind: 'waypoint', index},
      };
    }),

  setWaypoint: (index, place) =>
    set(state => {
      if (index < 0 || index >= state.waypoints.length) {
        return state;
      }
      const next = state.waypoints.slice();
      next[index] = place;
      return {waypoints: next};
    }),

  removeWaypoint: index =>
    set(state => ({
      waypoints: state.waypoints.filter((_, i) => i !== index),
    })),

  swap: () =>
    set(state => ({origin: state.destination, destination: state.origin})),
  reset: () =>
    set({
      origin: null,
      destination: null,
      waypoints: [],
      editing: {kind: 'destination'},
    }),
}));
