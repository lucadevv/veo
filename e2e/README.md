# VEO · E2E cross-servicio orquestado (golden path)

Este paquete (`@veo/e2e`) contiene el **E2E del "golden path"**: el flujo extremo a extremo de un
viaje, validado contra **varios servicios + BFFs reales a la vez**, hablando con los BFFs por HTTP/WS
y verificando estados (APIs) y eventos (Kafka).

A diferencia de los e2e individuales de cada servicio (testcontainers) y de los specs de **contrato**
BFF↔servicio (que se auto-omiten con `test.skip` cuando el downstream no responde), este harness
**levanta el stack mínimo** (identity, trip, dispatch, payment, panic + public-bff + driver-bff) sobre
el dev-stack y corre el viaje completo.

## Qué valida (flujo orquestado, multi-servicio)

1. **Pasajero**: solicita OTP → login (identity vía public-bff).
2. **Conductor**: login + onboarding + (aprobación seed) + **gate biométrico sandbox** → `AVAILABLE`.
3. **Conductor** se conecta al socket `/driver` y **publica ubicación** → `driver.location_updated`
   (Kafka) → hot index de dispatch.
4. **Pasajero crea viaje** (public-bff → trip-service `REQUESTED` → `trip.requested`) → **dispatch**
   hace matching y **ofrece** por el socket (`dispatch:offer`) → el **conductor acepta la oferta**
   (`POST /dispatch/offers/:matchId/accept`) → `dispatch.match_found` → trip `ASSIGNED`.
5. **Ciclo FSM** (driver-bff → trip-service): `ACCEPTED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED`.
6. **Cobro automático**: payment-service consume `trip.completed` → `payment.captured` (BR-P01) +
   **propina** (`POST /trips/:id/tip`).
7. **Pánico**: el pasajero obtiene el secreto HMAC (`/auth/panic-key`), **firma** el cuerpo y dispara
   `POST /panic`. Se mide el **ack < 3s** (SLO) y se verifica el fan-out `panic.triggered` (Kafka).
8. Estado final del viaje vía API del pasajero = `COMPLETED`.

## Prerrequisitos

- **Docker** (dev-stack) + **pnpm 9** + **Node 22**.
- Dependencias instaladas: `pnpm install` (en la raíz del monorepo).
- Infra del dev-stack arriba (el script la levanta si falta): **Postgres 5433, Redis 6379, Kafka 9094**.
  - Los schemas Postgres por servicio ya existen (`dev-stack/init-postgres.sql`).
  - Las migraciones Prisma ya están aplicadas al dev-stack (ver `docs/STATUS.md`). Si reseteaste el
    volumen de Postgres, vuelve a aplicarlas antes de correr.

> Modos **sandbox** forzados por el harness: SMS (OTP solo en log → lo inyectamos en Redis),
> biometría (determinista), pagos y evidencia de pánico. Mapas en modo **local** (no requiere el
> perfil `maps`/OSRM/Nominatim). Ver `lib/config.ts`.

## Cómo correrlo

Desde la raíz del monorepo:

```bash
pnpm e2e:golden
```

Eso ejecuta `e2e/scripts/run-golden.sh`, que:

1. levanta la infra mínima del dev-stack si no está corriendo (`postgres redis kafka`);
2. corre la suite vitest, que a su vez **compila** `@veo/*` + los 7 proyectos a `dist`, **arranca**
   identity/trip/dispatch/payment/panic + public-bff/driver-bff en background (`start:prod`), espera
   el **health** de todos, ejecuta el golden path y **apaga** todos los procesos al terminar.

Variante directa (sin el wrapper de infra), útil si el dev-stack ya está arriba:

```bash
pnpm --filter @veo/e2e e2e:golden        # = vitest run golden-path
```

### Flags útiles (env)

| Variable                                                                         | Efecto                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `E2E_GOLDEN=force`                                                               | corre aunque el detector de infra dude (CI con stack garantizado).                    |
| `E2E_GOLDEN=skip`                                                                | omite la suite siempre.                                                               |
| `E2E_SKIP_BUILD=1`                                                               | no recompila los servicios/BFFs (úsalo solo si su `dist` ya está fresco).             |
| `E2E_SERVICE_LOG_LEVEL=info`                                                     | sube el log de los servicios arrancados (default `warn`).                             |
| `E2E_KEEP_INFRA=1`                                                               | el wrapper no apaga el dev-stack al terminar (lo deja arriba igualmente por defecto). |
| `E2E_DATABASE_URL_BASE`, `E2E_REDIS_URL`, `E2E_KAFKA_BROKER`, `E2E_PG_CONTAINER` | overrides de infra.                                                                   |

## Gate de auto-omisión

Como los specs de contrato existentes, si la infra del dev-stack **no está arriba** (o falta Docker),
la suite se **omite limpio** (`describe.skip`) con un mensaje del motivo — pero con la lógica REAL
escrita. Si la infra SÍ está arriba, el harness levanta el resto del stack solo. Ver `lib/gate.ts`.

## Estructura

```
e2e/
  golden-path/
    golden-path.e2e.spec.ts   # la suite (8 pasos del golden path)
  lib/
    config.ts        # puertos/URLs/env de los 7 procesos + secretos + par JWT compartido
    orchestrator.ts  # build (turbo) + copia del cliente Prisma a dist + spawn start:prod + health + teardown
    gate.ts          # detección de infra (Docker/Postgres/Redis/Kafka) → ready/skip
    fixtures.ts      # inyección de OTP en Redis, aprobación del conductor (docker exec psql), limpieza hot index
    http.ts          # cliente HTTP de los BFFs (Bearer)
    driver-socket.ts # socket.io-client /driver (publica location, escucha dispatch:offer)
    events.ts        # colector de eventos Kafka (asserts de trip.requested/completed, payment.captured, panic.triggered…)
    panic.ts         # firma HMAC del pánico (mensaje canónico v1) + uuidv7
    wait.ts          # helpers de poll/espera (health, TCP, eventos)
  scripts/run-golden.sh        # wrapper: infra up + corre la suite
```

## Notas de implementación (decisiones)

- **Orquestación sin imágenes Docker por servicio** (alternativa válida del enunciado): reusamos el
  dev-stack para infra y arrancamos cada servicio/BFF **compilado** (`start:prod` = `node dist/main`).
  Es determinista (a diferencia de `nest start --watch`, que con `deleteOutDir` deja `dist` a medias
  si se interrumpe).
- **Fix de build a `dist`** (gap conocido en `docs/STATUS.md`): el `tsconfig.tsbuildinfo` viejo +
  `incremental` hacía que `nest build` no emitiera; el orquestador lo borra antes de compilar. Y como
  `tsc` no copia el **cliente Prisma generado** (`src/generated`), el orquestador lo copia a
  `dist/generated` tras el build (si no, `require('../generated/prisma')` falla en runtime).
- **Seeds que no son el path a validar**: el OTP llega por SMS (sandbox solo lo loguea), así que lo
  **inyectamos en Redis** con el mismo formato que `OtpService` (sha256, clave `veo:otp:+51XXXXXXXXX`).
  La **aprobación del conductor** la hace un operador admin (RBAC+TOTP); aquí se aprueba directo en la
  DB de identity (`docker exec psql`). Ambos son entradas, no el flujo a validar.
- **Par JWT ES256 compartido**: el harness inyecta a todos los procesos el mismo par (el ya commiteado
  en los `.env` de identity/public-bff/driver-bff) para que los tokens que emite identity los validen
  ambos BFFs.
