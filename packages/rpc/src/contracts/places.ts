/**
 * Tipos wire de veo.places.v1 (proto/places.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; enums:String → PlaceKind llega como string; defaults:true).
 */

/** Lugar guardado del pasajero. kind: HOME | WORK | FAVORITE (enum serializado como string). */
export interface SavedPlace {
  id: string;
  kind: string;
  label: string;
  /** Dirección/subtítulo legible; "" si no se registró. */
  subtitle: string;
  lat: number;
  lng: number;
  /** ISO-8601 de creación (orden de favoritos). */
  createdAt: string;
  /** ISO-8601 de última modificación. */
  updatedAt: string;
}

/** places.ListByUser → lista ordenada (HOME, WORK, luego FAVORITEs por createdAt desc). */
export interface PlacesReply {
  places: SavedPlace[];
}

/** places.Save / places.Update → el lugar resultante. */
export interface PlaceReply {
  place: SavedPlace;
}

/** places.Remove → confirmación de borrado. */
export interface RemoveReply {
  removed: boolean;
}
