# VEO · Mapas OSM soberanos (dev-stack, perfil `maps`)

Pila 100% self-hosted, sin Mapbox/Google:

| Servicio        | Rol                                   | Puerto host | Datos requeridos                     |
|-----------------|---------------------------------------|-------------|--------------------------------------|
| `tileserver`    | Tiles vectoriales para MapLibre GL    | 8082        | `maps/tiles/region.mbtiles` + `config.json` |
| `osrm`          | Ruteo (rutas, ETA, matrices)          | 5005        | `maps/osrm/region.osrm*` (preproc.)  |
| `nominatim`     | Geocoding / reverse geocoding         | 8081        | `maps/nominatim/data/region.osm.pbf` |

`@veo/maps` (paquete) usa estos servicios vía `OsrmMapsClient` (ruteo) y la URL de tiles
se inyecta al front por env (`NEXT_PUBLIC_TILE_URL`). LiveKit (video) ya está en el compose base.

## Preparar los datos (una vez)

Requiere Docker y `wget`/`curl`. Por defecto usa el extracto de **Perú** de Geofabrik.

```bash
cd dev-stack/maps
# Región por defecto: peru. Override con REGION_URL para otra zona.
./prepare.sh
# o una región específica:
REGION_URL="https://download.geofabrik.de/south-america/peru-latest.osm.pbf" ./prepare.sh
```

El script:
1. Descarga `region.osm.pbf` (Geofabrik).
2. Genera tiles vectoriales `region.mbtiles` con **Planetiler** (Java, en Docker) y escribe `tiles/config.json`.
3. Preprocesa OSRM (`osrm-extract → osrm-partition → osrm-customize`, perfil `car`, algoritmo MLD) en `osrm/`.
4. Copia el `.pbf` a `nominatim/data/` (Nominatim auto-importa en su primer arranque).

## Levantar

```bash
docker compose --profile maps up -d tileserver osrm nominatim
```

Verificación rápida:
- Tiles:   `http://localhost:8082/`
- Ruteo:   `http://localhost:5005/route/v1/driving/-77.03,-12.05;-77.01,-12.06?overview=false`
- Geocode: `http://localhost:8081/search?q=Miraflores,Lima&format=json`

> El stack base (`docker compose up -d`) NO levanta mapas para no exigir datos pesados.
> Solo el perfil `maps` los activa, tras correr `prepare.sh`.
