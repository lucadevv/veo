# VEO Family Web

App separada, **pública, sin login, sin app store**. Next.js 14 (App Router).

## Para qué existe

Cuando un pasajero comparte un viaje con un contacto de confianza, el contacto recibe un link firmado
(`https://ver.veo.pe/t/{token}`). Al abrirlo ve, en tiempo real y sin instalar nada:

- Mapa en vivo con la ubicación del conductor, origen, destino y la ruta (MapLibre + tiles OSM self-hosted).
- Estado del viaje y tiempo de llegada en lenguaje natural.
- Datos del conductor y del vehículo (nombre, calificación, placa, modelo, color).
- Botón de ayuda visible.
- Cámara del habitáculo (LiveKit self-hosted) **solo si el viaje lo autoriza**.

## Soberanía (no negociable)

- Mapas: **MapLibre GL + tiles OSM self-hosted** (nunca Mapbox/Google).
- Fuentes: **next/font** (auto-hospedadas, sin CDN en runtime).
- Video: **livekit-client** contra LiveKit self-hosted (token entregado por el bff).
- Datos en vivo: **public-bff** real (REST + Socket.IO namespace `/family`). Sin mocks ni hardcodeo.

## Rutas

```
src/app/
├── page.tsx              # Landing pública (qué es VEO Family, cómo funciona el link)
├── t/[token]/page.tsx    # Núcleo: carga server-side + estados + vista en vivo
└── t/[token]/loading.tsx # Skeleton de carga
```

## Estados manejados

`activo` (mapa en vivo) · `viaje finalizado` (completado/cancelado) · `link expirado` · `link revocado` ·
`link inválido` · `bff no disponible` (con reintento). Todos con copy humano, nunca errores crudos.

## Variables de entorno

Copia `.env.example` a `.env.local`. Resumen:

| Variable                  | Uso                                                                         |
| ------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_BFF_URL`     | Base REST del public-bff (cliente). Default `http://localhost:4001/api/v1`. |
| `PUBLIC_BFF_URL`          | Base REST para el render server-side (opcional, host interno).              |
| `NEXT_PUBLIC_BFF_WS_URL`  | Origen Socket.IO del public-bff (namespace `/family`).                      |
| `NEXT_PUBLIC_TILE_URL`    | Tiles OSM self-hosted (plantilla XYZ o style.json).                         |
| `NEXT_PUBLIC_LIVEKIT_URL` | Servidor LiveKit self-hosted (wss).                                         |
| `NEXT_PUBLIC_HELP_PHONE`  | Teléfono del botón de ayuda (default 105, PNP).                             |

## Comandos

```bash
pnpm --filter @veo/family-web dev        # http://localhost:5100
pnpm --filter @veo/family-web build
pnpm --filter @veo/family-web typecheck
pnpm --filter @veo/family-web lint
pnpm --filter @veo/family-web test:e2e   # Playwright (omite tests de bff si no responde)
```
