# VEO Admin · Dashboard de operación y seguridad

Next.js 14 (App Router) · Tailwind (tokens OKLCH compartidos) · React Query · MapLibre GL (tiles OSM self-hosted) · Socket.IO.

Centro de control data-first con dark mode de primera clase. Sin mocks: todos los datos vienen
del **admin-bff** real a través de un proxy server-side del propio origen.

## Modelo de autenticación (BFF-for-frontend)

El admin-bff usa Bearer JWT. admin-web gestiona la **sesión como cookies httpOnly+Secure+SameSite=Lax
en su propio origen**; el token NUNCA llega a JavaScript.

- `POST /api/auth/login` → proxea a `admin-bff /auth/login`. Si OK, guarda `access`+`refresh` en
  cookies httpOnly. Si exige TOTP, guarda un `mfaToken` efímero y devuelve `mfa_required` (con
  enrolamiento si es primer uso).
- `POST /api/auth/totp/confirm` → completa el login con el `mfaToken` + código TOTP.
- `POST /api/auth/step-up` → MFA fresco para acciones sensibles (video). Renueva la cookie de access.
- `POST /api/auth/logout` → revoca en el bff y limpia cookies.
- `GET /api/auth/session` → `sessionUser` (lo usa el layout para validar y aplicar RBAC).
- `GET /api/auth/ws-ticket` → ticket efímero para autenticar Socket.IO sin exponer el JWT.
- `GET|POST|... /api/bff/[...path]` → proxy genérico: adjunta `Authorization: Bearer` desde la cookie
  y, ante 401, intenta refresh (rotación) una vez y reintenta.

El `middleware` protege `/(dashboard)` por presencia de cookie; la validación autoritativa + RBAC
ocurre en el layout (Server Component) vía `getSession()`.

## Soberanía

- Mapas con **MapLibre GL + tiles OSM self-hosted** (`NEXT_PUBLIC_TILE_URL`). Fallback a un estilo
  mínimo propio si el tileserver no responde (jamás tiles de terceros).
- Fuentes self-hosted con `next/font` (Inter/JetBrains Mono se descargan y empaquetan en build).
- CSP estricta que solo permite el origen del tileserver y el websocket del bff.

## Variables de entorno

Ver `.env.example`. Server-side: `ADMIN_BFF_URL` (incluye `/api/v1`). Públicas:
`NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_BFF_WS_URL`, `NEXT_PUBLIC_BFF_URL`, `NEXT_PUBLIC_MAP_*`.

## Rutas

- `/login` (+ paso TOTP / enrolamiento)
- `/ops` mapa en vivo + KPIs + viajes activos + banner de pánico (Socket.IO `/ops`)
- `/ops/trips` (tabla densa, filtros persistentes, paginación cursor) · `/ops/trips/[id]`
- `/ops/drivers` (aprobación de altas)
- `/security/panics` · `/security/panics/[id]` (ack/resolve, evidencia, mapa)
- `/fleet` (documentos, vehículos, inspecciones, vencimientos)
- `/finance` (payouts, reembolsos) — gated por rol FINANCE
- `/media` (acceso a video con step-up MFA, reproducción con watermark)
- `/audit` (registro + verificación de cadena de hash)

## Comandos

```bash
pnpm --filter @veo/admin-web dev        # http://localhost:5001
pnpm --filter @veo/admin-web typecheck
pnpm --filter @veo/admin-web lint
pnpm --filter @veo/admin-web build
pnpm --filter @veo/admin-web test       # vitest (unit)
pnpm --filter @veo/admin-web test:e2e   # Playwright (baseURL configurable; skip si el bff no responde)
```
