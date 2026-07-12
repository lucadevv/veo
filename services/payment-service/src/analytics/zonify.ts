/**
 * Zonificación lat/lng → DISTRITO de Lima (para el corte "Ingresos por distrito" del panel). Se resuelve UNA vez
 * en la captura del cobro (payments.service) y se persiste denormalizado en `Payment.district` — así el agregado
 * no re-zonifica ni hace join cross-service.
 *
 * PRIMERA PASADA (honesta): asignación por CENTROIDE MÁS CERCANO de los distritos principales de Lima
 * Metropolitana + Callao (coordenadas REALES de cada distrito), con un umbral de radio. Un punto fuera del radio
 * de todo centroide → `null` (fuera de cobertura, NO se inventa distrito). Es aproximado cerca de los límites
 * (un point-in-polygon contra el GeoJSON preciso de los 43 distritos, o PostGIS ST_Contains, es la evolución —
 * `Trip.origin` ya reserva `geography` para eso). Suficiente y HONESTO para arrancar la métrica con seam real.
 *
 * Determinista y sin dependencias (pura). No embebe polígonos (MB) — solo ~1 punto por distrito.
 */

/** Centroide aproximado (lat, lng) de los distritos con más actividad de ride-hailing en Lima + Callao. */
const DISTRICT_CENTROIDS: ReadonlyArray<{ name: string; lat: number; lng: number }> = [
  { name: 'Miraflores', lat: -12.121, lng: -77.03 },
  { name: 'San Isidro', lat: -12.097, lng: -77.036 },
  { name: 'Santiago de Surco', lat: -12.145, lng: -76.994 },
  { name: 'San Borja', lat: -12.108, lng: -77.0 },
  { name: 'Barranco', lat: -12.148, lng: -77.021 },
  { name: 'Surquillo', lat: -12.112, lng: -77.017 },
  { name: 'Lince', lat: -12.085, lng: -77.035 },
  { name: 'Jesús María', lat: -12.074, lng: -77.049 },
  { name: 'Magdalena del Mar', lat: -12.09, lng: -77.072 },
  { name: 'Pueblo Libre', lat: -12.074, lng: -77.063 },
  { name: 'San Miguel', lat: -12.077, lng: -77.092 },
  { name: 'La Molina', lat: -12.079, lng: -76.945 },
  { name: 'Chorrillos', lat: -12.176, lng: -77.016 },
  { name: 'La Victoria', lat: -12.07, lng: -77.014 },
  { name: 'Cercado de Lima', lat: -12.046, lng: -77.043 },
  { name: 'Breña', lat: -12.06, lng: -77.05 },
  { name: 'San Juan de Lurigancho', lat: -11.99, lng: -77.0 },
  { name: 'Ate', lat: -12.026, lng: -76.918 },
  { name: 'San Juan de Miraflores', lat: -12.16, lng: -76.97 },
  { name: 'Villa El Salvador', lat: -12.213, lng: -76.938 },
  { name: 'Los Olivos', lat: -11.958, lng: -77.07 },
  { name: 'Independencia', lat: -11.99, lng: -77.053 },
  { name: 'Comas', lat: -11.949, lng: -77.062 },
  { name: 'Callao', lat: -12.056, lng: -77.118 },
];

/** Radio máximo (km) para asignar un punto a un distrito por su centroide. Fuera de esto ⇒ null (sin cobertura). */
const MAX_ASSIGN_KM = 6;

/** Distancia haversine en km entre dos coordenadas. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Devuelve el distrito de Lima del punto, o `null` si no hay coordenadas o el punto cae fuera del radio de
 * cobertura (degradación honesta: sin distrito inventado). Coordenadas inválidas (NaN/fuera de rango) → null.
 */
export function zonifyLima(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let best: string | null = null;
  let bestKm = MAX_ASSIGN_KM;
  for (const d of DISTRICT_CENTROIDS) {
    const km = haversineKm(lat, lng, d.lat, d.lng);
    if (km <= bestKm) {
      bestKm = km;
      best = d.name;
    }
  }
  return best;
}
