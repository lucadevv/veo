# @veo/maps

Fachada de mapas **self-hosted** para VEO (soberanía FOUNDATION §0.7 — sin Google Maps).

- **`OsrmMapsClient`** — routing contra **OSRM/Valhalla** + geocoding contra **Nominatim**, ambos self-hosted. Caché Redis.
- **`LocalMapsEngine`** — motor de estimación propio (distancia gran círculo × factor de sinuosidad, duración por velocidad urbana media). Determinista, sin red. Para dev/CI sin OSRM cargado o como fallback.
- **`createMapsClient({ mode })`** — elige por `VEO_MAPS_MODE = 'osrm' | 'local'`.

## API (`MapsClient`)

```ts
route(origin, destination): Promise<RouteResult>   // { distanceMeters, durationSeconds, polyline }
eta(origin, destination): Promise<number>           // durationSeconds
geocode(query): Promise<GeocodeResult | null>
reverse(point): Promise<GeocodeResult | null>
```

## Consumidores

- `trip-service` — cálculo de tarifa BR-T05 (`base + S/1.2/km + S/0.30/min`).
- `dispatch-service` — ETA para scoring BR-T06.

## Caché

`RedisMapsCache` (prod) o `InMemoryMapsCache` (dev/tests). Las rutas y geocodes son estables, TTL por defecto 1h.
