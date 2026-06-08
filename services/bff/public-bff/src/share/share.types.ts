/** Vista de seguimiento que devuelve share-service en GET /public/share/:token. */
export interface ShareTrackingDownstream {
  shareId: string;
  tripId: string;
  status: string;
  startedAt: string | null;
  driverId: string | null;
  approximateLocation: { lat: number; lon: number; at: string } | null;
  viewedAt: string;
}

/** Enlace de seguimiento recién creado (POST /share/:tripId). */
export interface CreatedShareLink {
  shareId: string;
  token: string;
  url: string;
  tripId: string;
  contactId: string | null;
  expiresAt: string;
  maxUses: number;
}

/** Sala Socket.IO de un viaje en el namespace /family. */
export function familyRoom(tripId: string): string {
  return `trip:${tripId}`;
}

/** Sala Socket.IO de un viaje en el namespace /passenger (las salas son por-namespace). */
export function passengerRoom(tripId: string): string {
  return `trip:${tripId}`;
}
