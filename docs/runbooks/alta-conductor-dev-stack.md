# Runbook · Alta de conductor (DNI/licencia) en el dev-stack

Setup y **gaps del boot** que rompían el flujo de alta del conductor (escaneo + subida EAGER del DNI/licencia,
Lotes 0-5). Todos se auto-resuelven ahora al levantar (`./dev-stack/veo.sh up` / `pnpm infra:up`); esta nota
existe para reconocer el síntoma si vuelve a aparecer.

> Regla de oro cuando "el mobile falla al enviar el DNI en el device físico": el cartel de la UI
> ("problema de conexión") es GENÉRICO — mapea CUALQUIER error. El error REAL sale en el **DevTools de RN**
> (tecla `j` en Metro → Console), NO en la terminal de Metro (RN 0.85 no forwardea `console.log` ahí). Y los
> requests llegan a los logs del backend en `dev-stack/logs/{driver-bff,identity,media}.log` — leelos.

## Gap 1 · `DNI_HASH_SALT` no inyectado → el identity crashea al boot / el check-dni revienta

**Síntoma:** el `identity-service` no bootea (o el `check-dni` da 500). Lote 0 exige `DNI_HASH_SALT`
(`config.getOrThrow`) para el blind index del DNI, pero el boot no lo generaba.
**Fix (durable):** `dev-stack/boot-passenger-stack.sh` genera un salt ESTABLE (`openssl rand`, reusado entre
restarts para que los `dni_hash` guardados sigan matcheando) y lo UPSERTea en `identity/env/development.env`.

## Gap 2 · Prisma client stale → `Unknown argument 'dniHash'`

**Síntoma:** `check-dni` da `ApiError 500: Invalid this.prisma.read.driver.findFirst()... Unknown argument
'dniHash'`. La migración estaba aplicada (el DB tiene la columna) pero el **Prisma client generado** era de
antes del cambio de schema — turbo cacheó el `codegen` y no lo regeneró.
**Fix (durable):** `turbo.json` → `codegen` con `"cache": false` (siempre regenera; es rápido, y el `build`
solo se rehace si el generado cambió). Nunca más queda el client stale tras tocar `schema.prisma`.
**Manual si hace falta ahora:** `pnpm exec prisma generate --schema=services/identity-service/prisma/schema.prisma`
+ `./dev-stack/veo.sh restart identity` (el `nest-cli.json` copia `generated/prisma` al `dist`).

## Gap 3 · Buckets de MinIO no creados → `404 NoSuchBucket` al subir el binario

**Síntoma:** `check-dni` y el PATCH pasan (el driver se crea), pero el PUT del binario da
`DocumentUploadError: El almacén de objetos respondió 404`. El bucket `veo-documents-dev` (DNI/licencia) no
existía — el sidecar `minio-provision` del compose nunca se disparaba (no estaba en el boot).
**Fix (durable):** `dev-stack/veo.sh` dispara `docker compose up -d minio-provision` tras el `up` de la infra
(one-shot idempotente que espera `minio` healthy y crea `veo-avatars-dev`/`veo-video-dev`/`veo-documents-dev`
+ SSE-S3 en los buckets con PII).

## Gap 4 (transversal) · packages `@veo/*` stale → símbolo `undefined` en el mobile

**Síntoma:** en el device, `TypeError: Cannot read property 'parse' of undefined` (ej. un schema Zod
`driverCheckDniRequest` importado de `@veo/api-client`). La app importa el **dist buildeado** del package
(`"main": "./dist/index.js"`), no el `src`; si tocaste el `src/` sin rebuildear, el símbolo nuevo llega
`undefined`. El boot buildea los packages (`pnpm -r --filter ./packages/* build`), pero un cambio POST-boot
queda stale.
**Fix cuando pasa:** `pnpm --filter @veo/<pkg> build` + reiniciar **Metro con `--reset-cache`** (Metro cachea
el dist viejo del node_module; un reload no alcanza). Ver la memoria/engram del proyecto.

## Device físico (iOS) — red

El `env/development.env` del driver deja las URLs del backend VACÍAS a propósito: la app AUTO-DERIVA el BFF
del host de Metro (`getDevServer()`, compatible bridgeless). En el device físico eso resuelve a la IP LAN del
Mac (ej. `http://192.168.18.248:4002/api/v1`) — verificable con el log `[ENV-DEBUG]` que se puede dejar
temporalmente en `env.ts`. El object store se firma contra `S3_PUBLIC_BASE_URL` (la IP LAN), device-reachable.
