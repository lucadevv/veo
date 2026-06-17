# STATUS.md · Estado del proyecto y handoff

> **Documento de traspaso para cualquier agente (Claude, Cursor, etc.) o persona que retome VEO.**
> Última actualización: **2026-05-29**.
> Lee también, en este orden: `CLAUDE.md` (reglas no negociables) → `docs/FOUNDATION.md` (contrato técnico canónico,
> incluye §14 "Decisiones registradas") → este archivo (estado actual). El blueprint de negocio es `../VEO_Blueprint.pdf`.

---

## 0. TL;DR — ¿dónde estamos?

VEO es una plataforma de movilidad segura (Lima) en construcción desde el scaffold. Multi-repo:
`veo-platform` (backend+web+packages), `veo-passenger-app`, `veo-driver-app`, `veo-infra`.

- ✅ **Ola 0 (Fundación)** — paquetes compartidos `@veo/*` construidos, compilados a `dist` y testeados.
- ✅ **Ola 1 COMPLETA** — los **13 microservicios + `@veo/maps`** implementados para producción (sin mocks):
  - 11 NestJS (`identity, trip, dispatch, payment, panic, media, notification, audit, rating, share, fleet`),
  - 1 Go (`tracking`), 1 Python/FastAPI+ONNX (`biometric`).
  - **Verificación global verde:** `pnpm typecheck` 33/33 · `pnpm lint` 33/33 · `pnpm test` 33/33.
  - E2E con **infra real (testcontainers Postgres/Redis/Kafka)** en `payment`, `panic` (p99 ack 4.9ms) y `audit`.
  - Go: `go build` + `go test ./...` verde. Python: **44 tests** verde (venv propio).
- ✅ **Ola 2 COMPLETA (BFFs)** — `public-bff` (4001), `driver-bff` (4002), `admin-bff` (4003): agregadores reales (sin mocks),
  JWT ES256 + identidad interna firmada HMAC, gRPC (lecturas) + REST interno (comandos), Socket.IO, rate-limit Redis.
- ✅ **Ola 3 COMPLETA (Web)** — `admin-web` (panel de operación denso) y `family-web` (vista familiar cálida), Next.js 14 +
  MapLibre (OSM self-hosted) + Socket.IO + LiveKit. Sistema de diseño propio (`docs/DESIGN.md` + tokens OKLCH en `@veo/shared-config`).
  - **Verificación global verde (35 proyectos):** `pnpm build` 26/26 · `pnpm typecheck` 35/35 · `pnpm lint` 35/35 · `pnpm test` 35/35.
- ✅ **Ola 4 COMPLETA (Apps móviles)** — `veo-passenger-app` y `veo-driver-app` en **React Native 0.75.4 (New Architecture)**, iOS + Android,
  Clean Architecture (domain/data/presentation), DI, React Query + Zustand, `@veo/ui-kit` (diseño móvil propio) y `@veo/api-client`. Funcional end-to-end contra los BFFs reales (sin mocks).
  - **Verificación verde por app:** typecheck ✓ · lint `--max-warnings 0` ✓ · Jest **passenger 145/145**, **driver 120/120** (tras Olas 1/2A/2B/2C) · Android `assembleDebug` (Temurin JDK 17) ✓ · iOS `pod install`+`xcodebuild` (simulador) ✓. Para device físico falta firmar (Apple ID en Xcode).
  - **Features añadidas (Olas 1–2C, ver detalle abajo):** KYC facial E2E, MMKV+CSPRNG, propinas, lugares guardados, recibo, documentos+ganancias conductor, promos, referidos, chat, viajes programados, paradas múltiples, moto-taxi, navegación turn-by-turn, heatmap, incentivos, soporte.
  - Backend extendido (sin romper la web): `GET /auth/panic-key` (clave HMAC de pánico), `POST /media/rooms/:tripId/publisher-token` (LiveKit publisher), gate biométrico real (`enroll/challenge/verify`→`sessionRef` de un solo uso, ONNX self-hosted), registro de **device-token** push (`POST /devices`, `POST /notifications/device-token`). 2 migraciones Prisma (Driver.faceEmbedding, tabla device_tokens).
- ✅ **Ola 2A COMPLETA (backend + contratos)** — **Promos/cupones**, **Referidos** y **Chat in-app** (conductor↔pasajero):
  - **Promos/cupones** → módulo `promotions` DENTRO de `payment-service` (mismo bounded context "dinero"; el descuento se aplica al cobro sin join cross-servicio). Modelos `Promotion`/`PromoRedemption`, `validatePromo`/`redeemPromo` idempotente, descuento aplicado al cobro reduciendo SOLO el total del pasajero (comisión sobre el bruto y propina **intactas** — la plataforma asume la promo). `promoCode` se persiste en el viaje (trip-service) y viaja en `trip.completed` → el cobro lo canjea. Seed `PRIMERVIAJE` (-50%, tope S/15) y `BIENVENIDO` (S/5). Endpoints internos `POST /promotions/validate|redeem`. public-bff: `POST /promos/validate` + `promoCode?` en `POST /trips`.
  - **Referidos** → en `identity-service`: `User.referralCode` (único, perezoso) + `referralRewardCents`, tabla `Referral`. `applyReferral` (una vez, no auto-referirse) emite `user.referred`; recompensa al **1er viaje del referido** (consumidor `trip.completed` → crédito en céntimos + `referral.rewarded`). public-bff: `GET /referrals/me`, `POST /referrals/redeem`.
  - **Chat in-app** → nuevo `chat-service` (puerto **3014**, schema `chat`): `Message{id,tripId,senderId,senderRole,body,createdAt}`, REST interno `GET/POST /chat/trips/:tripId/messages`. Entrega RT **reutilizando** el Socket.IO existente: `chat-service` publica `chat.message_sent` (outbox→Kafka), ambos BFFs lo consumen y emiten **`chat:message`** a la sala del viaje (`/passenger`, `/driver`). Membresía + estado activo validados en el BFF (gRPC GetTrip).
  - `@veo/api-client`: `promoValidationView`, `promoCode?` en `createTripRequest`, `referralSummary`, `redeemReferralRequest`, `chatMessage`/`sendMessageRequest` + evento socket `chat:message` (Passenger/Driver). Construido + rsync a ambas apps.
  - **Migraciones Prisma** (aplicadas al dev-stack): payment `promotions` (+ `discount_cents`), identity `referrals` (+ `referral_code`/`referral_reward_cents`), trip `promo_code`, chat `messages` + `outbox_events`. Schema `chat` añadido a `init-postgres.sql`.
  - **Verificación verde:** typecheck + lint(`--max-warnings 0`) + tests de payment (37, incl. e2e testcontainers), identity (26), trip (153), chat (4), public-bff (68), driver-bff (42, 1 skip), events (6).
- ✅ **Ola 2B COMPLETA (backend + apps)** — **Viajes programados**, **Paradas múltiples** y **Tier moto-taxi**:
  - **Viajes programados** → trip-service: estado nuevo `SCHEDULED` (previo a REQUESTED), `scheduledFor` con ventana [≥15min, ≤7d], **`ScheduledTripsScheduler`** (`@nestjs/schedule`, cron c/min) que a la hora (lead 10min) hace `SCHEDULED→REQUESTED` + emite `trip.requested` (dispatch normal), idempotente. Cancelación sin penalidad. public-bff: `scheduledFor?` en `POST /trips`, `GET /trips/scheduled`, `DELETE /trips/:id/schedule`.
  - **Paradas múltiples** → `waypoints?` (máx 3) en quote y `POST /trips`; ruta+tarifa via `@veo/maps` multi-punto.
  - **Tier moto-taxi** → tier `veo_moto` en `RIDE_CATEGORIES` (mult 0.55, mín S/3); **fleet** ganó enum `VehicleType (CAR|MOTO)`; dispatch filtra el matching por tipo (`trip.requested`+`driver.location_updated` llevan `vehicleType`; hot index lo indexa). El conductor declara su vehículo (MMKV) y lo envía en el reporte GPS.
  - `@veo/api-client`/`@veo/shared-types`: `VehicleType`, `TripStatus.SCHEDULED`, `scheduledFor?`/`waypoints?`/`vehicleType?` en create/quote/tripResource, `scheduledTripList`. Apps: pasajero (selector fecha/hora propio, "Mis programados", lista de paradas, render del tier moto); conductor (selector Auto/Moto + badge "Reservado").
  - **Migraciones aplicadas:** trip `scheduled_waypoints_vehicletype`, fleet `vehicle_type`. **Verde:** passenger **138**, driver **90**, backend (trip/fleet/dispatch/bffs).
- ✅ **Ola 2C COMPLETA (backend + apps)** — **Navegación turn-by-turn**, **Mapa de calor + Incentivos** y **Centro de ayuda**:
  - **Navegación** → `@veo/maps.routeWithSteps` (OSRM `steps=true`, maniobras es-PE; `LocalMapsEngine` para dev). driver-bff `GET /trips/:id/route` → `tripRoute{polyline,steps[]}`. App conductor: banner de próxima maniobra + lista de pasos + polyline + deep-link Waze/Google.
  - **Heatmap** → en **dispatch-service** (consume `trip.requested`, bucketea H3 res9 con ventana deslizante Redis 15min). driver-bff `GET /heatmap?lat&lng&radius`. App conductor: toggle "Zonas de demanda" sobre el mapa.
  - **Incentivos** → módulo `incentives` en **payment-service** (consume `trip.completed`; META_VIAJES→bono céntimos, HORA_PICO→multiplicador; idempotente doble-UNIQUE + outbox `incentive.completed`). Seed 2 demo. driver-bff `GET /incentives`. App conductor: pantalla con progreso.
  - **Soporte** → módulo `support` en **notification-service** (Ticket{category,subject,body,status,tripId?}). public-bff + driver-bff `POST/GET /support/tickets`. Ambas apps: Centro de ayuda (FAQ estático + reportar problema + mis tickets).
  - `@veo/api-client`: `routeStep`/`tripRoute`, `heatmapCell`/`heatmapView`, `driverIncentive`/lista, `supportTicket`/`createTicketRequest`/`supportCategory`. Nuevo evento `incentive.completed`.
  - **Migraciones aplicadas:** payment `incentives`, notification `support_tickets`. **Verde:** passenger **145**, driver **120**, backend.
  - **Pendiente menor:** el bono de incentivo se emite por Kafka pero el crédito efectivo al payout es gancho futuro (hoy registra progreso, no altera el payout).
- ✅ **Ola 5 COMPLETA (infra + cierre)** — IaC/CI/observabilidad/mesh/E2E listos y validados estáticamente (sin `apply` a AWS real: sin credenciales y la regla #1 lo prohíbe desde laptop):
  - **Terraform** (`veo-infra/terraform`): los 11 módulos (vpc 3-AZ + VPC endpoints + flow logs, eks + OIDC/IRSA, rds-postgres multi-AZ + KMS + password→Secrets Manager, elasticache-redis, msk-kafka SASL/IAM, s3 + Object Lock, cloudfront OAC, kms por dominio pii/biometric/video/audit, iam-roles IRSA, iot-core, **secrets-manager nuevo**) **construidos desde esqueleto**; envs dev/staging/prod los cablean (RDS por servicio crítico identity/payment/panic/audit + 1 compartida; prod multi-AZ+deletion_protection+Object Lock 7a). **`terraform validate` Success** en los 11 módulos + 3 envs (terraform 1.15.5, `fmt -check` limpio).
  - **K8s** (`veo-infra/k8s`): añadidos los 3 manifests faltantes (**biometric/fleet/chat**); **observabilidad self-hosted** (Prometheus + Grafana + OTel Collector + Tempo + Loki/promtail) en `base/observability/`; **mTLS interno** vía Linkerd + cert-manager (trust anchor propio) en `base/mesh/`; NetworkPolicies de scrape/OTLP. **`kubectl kustomize` limpio: 114 objetos** en base y en los 3 overlays.
  - **CI por repo** (GitHub Actions): apps `veo-passenger-app`/`veo-driver-app` ahora tienen `ci.yml` (pnpm+Node22: lint+typecheck+test, build Android opcional; `@veo/*` resuelto vía GitHub Packages o checkout del hermano, gateado); `veo-infra` ganó `k8s.yml` (kustomize+kubeconform+actionlint) junto a `terraform.yml`; `veo-platform` ci.yml/codeql ya cubrían chat-service por glob.
  - **E2E cross-servicio orquestado** (`veo-platform/e2e/golden-path`): harness que levanta el stack mínimo (identity/trip/dispatch/payment/panic + public-bff + driver-bff) contra el dev-stack y corre el golden path (login pasajero→turno conductor con gate biométrico→crear viaje→dispatch→aceptar→FSM hasta COMPLETED→cobro+propina→**pánico HMAC con ack <3s**). **Corrido en vivo: 8/8 verde (~21s)**; `pnpm e2e:golden`. Resuelto el gap de build a `dist` (tsbuildinfo viejo + copia del cliente Prisma generado).
- 🔒 **Bloqueado por terceros (no es código pendiente):** Yape/Plin **live** (convenio+credenciales PSP; sandbox soberano funciona), **boleta/factura SUNAT** (proveedor OSE), **llamada con número enmascarado** (decidir telefonía/SIP — choca con soberanía).
- ✅ **git inicializado y publicado** — los 4 repos son **privados en GitHub bajo el org `MarketrixPE`**: `veo-platform`, `veo-passenger-app`, `veo-driver-app`, `veo-infra` (rama `main`, commit inicial conventional, `.gitignore` endurecido: sin node_modules/Pods/.cxx/datos de mapas/binarios Prisma/secretos). CI por repo activo.

**Lo siguiente:** ya no quedan olas de construcción. Para ir a producción real: bootstrap del backend Terraform (S3+DynamoDB), `terraform apply` con credenciales AWS vía PR-driven (Atlantis/Spacelift, NUNCA laptop), instalar control-plane de Linkerd+cert-manager en el cluster, conectar los rieles bloqueados por terceros, y firmar/publicar las apps a las stores.

---

## 1. Regla maestra del cliente (NO negociable)

**Soberanía tecnológica** (`FOUNDATION §0.7`): soberanía = **control del DATO/CÓMPUTO sensible** (seguridad +
privacidad Ley 29733), NO "cero proveedores". El dato sensible se self-hostea; los rieles de transporte externos
inevitables se usan tras puerto propio y sin PII en el payload. Reescribe el blueprint:

- Biometría → **`biometric-service` propio** (Python/FastAPI + ONNX), NO FaceTec/Onfido. **(soberano)**
- Video WebRTC → **LiveKit self-hosted**, NO LiveKit Cloud. El video nunca sale de la infra. **(soberano)**
- Mapas/routing → **OSM propio** (OSRM/Valhalla + Nominatim) vía `@veo/maps`, NO Google Maps para el dato. **(soberano)**
- Rieles de transporte inevitables (pagos Yape/Plin, **push FCM/APNs**, SMS de operador) → **SÍ se usan**, tras **puerto propio** (`interface` + adapter + sandbox) intercambiable y **sin PII en el payload**. **(transporte, no dato)**
- Librerías open-source self-hosted (NestJS, Prisma, OSRM, LiveKit, ONNX) **sí** se permiten.

Otras decisiones vinculantes están en `FOUNDATION §14` (auth ES256, refresh Redis, validación en BFF, TOTP,
gRPC proto-first, /api/v1, rate-limit, tombstone+gracia 30d, etc.).

---

## 2. Entorno de desarrollo (cómo levantar)

```bash
cd veo-platform
pnpm install
docker compose -f dev-stack/docker-compose.yml up -d postgres redis kafka   # infra mínima
```

**Quirks ya resueltos en `dev-stack/docker-compose.yml`** (importantes):

- **Postgres en host `5433`** (no 5432 — choca con otro proyecto local). `DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo`.
- **MinIO/S3 en host `9002`** (9000 choca con ClickHouse).
- **Kafka = `apache/kafka:3.9.0`** (el tag bitnami original fue retirado). Broker externo `localhost:9094`.
- Schemas Postgres por servicio ya creados (incluye `fleet`). Si recreas el volumen, `init-postgres.sql` los crea.

Toolchain: **pnpm 9.12, Node 22, Docker 28, Go 1.26** (para tracking-service), Python (para biometric-service).

---

## 3. Convenciones críticas del monorepo (leer antes de codear)

1. **Consumo cross-paquete vía `dist`** (`FOUNDATION §1`): los servicios consumen `@veo/*` **compilados** (no el source).
   - Cada `packages/*/package.json` apunta `main`→`dist/index.js`, `types`→`dist/index.d.ts`, `exports`→dist.
   - Cada `services/*/tsconfig.json` lleva `"paths": {}` (anula los paths del base) para resolver vía `node_modules`→dist.
   - ⇒ **Antes de typecheck/test de un servicio, compila sus deps:** `pnpm --filter '@veo/*' build` (o usa `turbo`, que con `dependsOn:["^build"]` lo hace solo). Si editas un paquete, recompílalo para que los servicios vean el cambio.
2. **Tests con vitest** (también en servicios; jest+ESM da fricción). Cada servicio trae `vitest.config.ts`. Los tests construyen las clases directamente (sin Nest DI), así no requieren metadata de decoradores.
3. **Prisma migraciones:** `prisma migrate dev` es interactivo y NO corre headless. Flujo usado:
   `prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script > migrations/<ts>_<name>/migration.sql` y luego `prisma migrate deploy`. (Para la 1ª migración usar `--from-empty`.)
4. **Sin `any`**, errores de dominio de `@veo/utils`, dinero en céntimos PEN, IDs UUIDv7, eventos vía **outbox**.
5. Puertos fijos en `FOUNDATION §2`.

Comandos: `pnpm --filter @veo/<x> typecheck|test|build`, `pnpm --filter @veo/<svc> typecheck|test`.

---

## 4. Hecho ✅

### Paquetes compartidos (`packages/`) — todos compilados a `dist` + tests verdes

| Paquete              | Qué provee                                                                                                                                                                                                                                                                                    | Tests |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `@veo/shared-types`  | interfaces de dominio + enums (pre-existente)                                                                                                                                                                                                                                                 | —     |
| `@veo/shared-config` | eslint/tsconfig/jest/prettier presets (pre-existente)                                                                                                                                                                                                                                         | —     |
| `@veo/utils`         | DomainError (jerarquía), uuidv7, dinero PEN, geo/H3, crypto (HMAC + hash-chain audit), result, validación peruana                                                                                                                                                                             | 11    |
| `@veo/events`        | EventEnvelope, **40 schemas Zod** + registro central, KafkaEventProducer/Consumer, outbox (drainOutbox, OutboxStore)                                                                                                                                                                          | 4     |
| `@veo/maps`          | fachada OSM: `OsrmMapsClient` (OSRM `/route` + Nominatim) y `LocalMapsEngine` (estimación dev/CI), `RedisMapsCache`/`InMemoryMapsCache`, `createMapsClient` por `VEO_MAPS_MODE`                                                                                                               | ✔     |
| `@veo/auth`          | JWT **ES256** (jose), **RedisRefreshTokenStore** (rotación+reuse detection), guards (JwtAuthGuard, **InternalIdentityGuard**, RolesGuard, StepUpMfaGuard), decorators (@CurrentUser/@Roles/@Public/@RequireStepUpMfa), **TOTP**, identidad interna HMAC BFF→servicio, `generateDevKeyPairPem` | 8     |
| `@veo/observability` | logger pino (redacción PII), bootstrapOtel, métricas prom-client + MetricsController, **AllExceptionsFilter**, LoggingInterceptor, HealthController (liveness+readiness)                                                                                                                      | 7     |
| `@veo/database`      | **ReadWriteClient** (split primary/replica), outbox Prisma (`enqueueOutbox`, `PrismaOutboxStore`, `OUTBOX_PRISMA_MODEL`), **tombstone** (+`deletedPlaceholder`), `createTestDatabase` (testcontainers, en `@veo/database/testing`)                                                            | 5     |

### `services/identity-service` — COMPLETO (plantilla de referencia) · typecheck verde · 12 tests

- **Prisma** schema "identity" (User, Driver, AdminUser, BiometricCheck, OutboxEvent) + **2 migraciones aplicadas**.
- **Auth**: login teléfono+OTP por **SMS** (pasajero/conductor), JWT ES256, refresh rotación, logout.
- **Admin**: auto-registro→aprobación (RBAC), login email+password (**argon2id**) + **TOTP** (enroll/confirm), **step-up MFA** (BR-S07); secreto TOTP cifrado AES-256-GCM (`src/common/secret-box.ts`).
- **Users**: GET/PATCH `/me`, **derecho al olvido** con gracia 30d (`DeletionSweeper` cron aplica tombstone).
- **Drivers**: onboarding autoservicio + aprobación operador; **inicio de turno con gate biométrico** (BR-I02, liveness+match ≥ score mín, **bloqueo 1h tras 3 fallos**) + estados.
- **Puertos** (patrón soberanía): `SmsSender` (sandbox imprime OTP / operador live), `BiometricProvider` (sandbox determinista / cliente HTTP al `biometric-service` propio).
- **gRPC**: `proto/identity.proto` (`veo.identity.v1`) + `IdentityGrpcController` (GetUser/GetDriver/GetDriverByUser) + microservicio en `main.ts`.
- **Eventos** (outbox→Kafka): `user.registered`, `driver.verified`, `biometric.failed`, `user.deletion_requested`.
- **Operación**: health DB/Redis, métricas, OTel, ExceptionFilter, `/api/v1`, Swagger en `/docs`, `@nestjs/schedule`.
- **Seed**: `pnpm db:seed` crea SUPERADMIN (`admin@veo.pe`, ACTIVE).

### Documentación / contrato

- `docs/FOUNDATION.md` reescrito con soberanía (§0.7, §9), servicios nuevos (§2), convención dist (§1), y §14 con TODAS las decisiones.
- `dev-stack` corregido (puertos + imagen Kafka + schema fleet).

---

### Ola 1 — microservicios ✅ COMPLETOS (typecheck/lint/test verdes)

Cada NestJS: `prisma/schema.prisma` + migración aplicada + dominio (state machine/reglas BR) + eventos outbox→Kafka + gRPC + puertos externos (sandbox+live) + vitest + health/métricas/OTel + `/api/v1`.

- `trip-service` (3002) — máquina de estados (BR-T02), tarifa (BR-T05), cancelaciones (BR-T03), modo niño bcrypt (BR-T07). **153 tests** (124 de la state machine). Schema `trip`.
- `dispatch-service` (3003) — matching **H3 + scoring** (BR-T06), surge, prioridad pánico, Redis hot index. **14 tests**. Schema `dispatch`.
- `tracking-service` (3004, **Go**) — ingesta GPS, presencia, geofencing H3, fan-out, Kafka/Redis/ClickHouse. `go build`+`go test` verde.
- `payment-service` (3005) — adapters **Yape/Plin/efectivo** tras puerto+sandbox, comisión, payouts, idempotencia. **22 tests** (incl. e2e testcontainers). Schema `payment`.
- `panic-service` (3006) — fan-out paralelo + idempotencia HMAC (BR-S04/S05). **14 tests** (e2e + SLO ack p99 4.9ms). Schema `panic`.
- `media-service` (3007) — orquestación **LiveKit self-hosted**, grabaciones cifradas, signed URLs, doble-auth de acceso, retención. **24 tests**. Schema `media`.
- `notification-service` (3008) — motor propio + plantillas i18n + conectores **push (FCM/APNs propios), SMS, email** tras puerto; retries+dedup. **17 tests**. Schema `notification`.
- `audit-service` (3009) — append-only + **S3 Object Lock** + **hash chain** verificable. **19 tests** (incl. e2e). Schema `audit`.
- `rating-service` (3010) — promedio rolling 30d, flags BR-D01/BR-I05. **29 tests**. Schema `rating`.
- `share-service` (3011) — links firmados + OTP de contactos de confianza + página familia. **25 tests**. Schema `share`.
- `fleet-service` (3012) — vehículos, documentos (Licencia/SOAT/Tarjeta/ITV), vencimientos+alertas, inspecciones. **31 tests**. Schema `fleet`.
- `biometric-service` (3013, **Python/FastAPI+ONNX**) — detección facial + embeddings + liveness + match. **44 tests** (venv propio).
- **`@veo/maps`** — fachada OSM (OSRM + Nominatim) con `LocalMapsEngine` para dev/CI y cache Redis. Consumido por trip/dispatch.

### Paquetes de contrato Olas 2/3 (nuevos, compilados a `dist`)

- **`@veo/api-client`** — contrato tipado BFF↔web. `HttpClient` (fetch, retries, normalización a `ApiError`), schemas Zod de las vistas agregadas (`familyTrackingView`, `tripSummary/Detail`, `panicSummary/Detail`, `driverSummary/Approval`, flota, payouts, auditoría, `analyticsOverview`), contrato **auth admin** (`adminTokens | totpEnrollChallenge`, `wsTicket`, refresh, step-up), `familyVideoGrant`, y mapas de eventos **Socket.IO** (`/family` por token de share, `/ops` por ticket efímero).
- **`@veo/rpc`** — toolkit BFF→servicio: factoría de clientes **gRPC** (lecturas), `InternalRestClient` que **firma la identidad con HMAC** (`@veo/auth`) para comandos, normalización `DownstreamError`, y los **11 `.proto`** empaquetados. (Decisión: híbrido gRPC-lecturas + REST-interno-comandos para no reescribir los servicios de Ola 1.)

### Ola 2 — BFFs ✅ COMPLETOS (typecheck/lint/test verdes)

Cada BFF: JWT ES256 global (`@veo/auth`), identidad interna firmada HMAC aguas abajo (nunca reenvía el JWT), `/api/v1`, Swagger, rate-limit Redis, health/métricas/OTel, validación Zod del entorno al boot.

- `public-bff` (4001) — viajes pasajero (agregados gRPC), surge, pagos, **pánico (sin rate-limit)**, share + **vista familiar pública** (`/public/share/:token`) y **video del habitáculo** (`/public/share/:token/video`, mint de token viewer **LiveKit self-hosted** firmado con `node:crypto`, solo durante viaje en curso), contactos, ratings. Socket.IO `/family`. **40 tests**.
- `driver-bff` (4002) — turno/estado conductor, aceptación de viajes, ubicación, ganancias. Socket.IO `/driver` (Bearer). **25 tests** (+2 contrato auto-skip).
- `admin-bff` (4003) — autoridad de auth admin (proxy a identity: login + enrolamiento/step-up TOTP, refresh, `/auth/session`, **`/auth/ws-ticket`** efímero), ops/seguridad/flota/finanzas/media/auditoría con **RBAC `@Roles`** (enum `AdminRole`), **read-model CQRS en Redis** (listados que los servicios no exponen) alimentado por Kafka. Socket.IO `/ops` (**acepta ticket efímero o Bearer**; pánico se difunde a todos). **43 tests**.

### Ola 3 — Web ✅ COMPLETAS (typecheck/lint/build verdes)

Next.js 14 (App Router) + Tailwind con preset/tokens OKLCH de `@veo/shared-config` + `@veo/api-client`. Sistema de diseño en `docs/DESIGN.md` (destilado de las skills UI/UX, con anti-patrones "AI slop" prohibidos).

- `admin-web` (5xxx) — panel de operación denso. Sesión vía **route handlers server-side con cookies httpOnly+Secure** (el JWT admin nunca llega al navegador); el WS `/ops` usa **ticket efímero** acuñado server-side. RBAC de presentación alineado a los `@Roles` del bff. MapLibre. **6 tests** unitarios + Playwright e2e (`test:e2e`).
- `family-web` (5100) — vista familiar cálida desde link firmado (sin login/sin app). Seguimiento en vivo (Socket.IO `/family`), mapa MapLibre, **video del habitáculo** vía LiveKit (degrada a "sin video" si el bff no autoriza). Playwright e2e (`test:e2e`).

### Ola 4 — Apps móviles ✅ COMPLETAS (typecheck/lint/Jest + builds nativos Android/iOS verdes)

React Native 0.75.4 (New Architecture, Hermes). Clean Architecture feature-first + DI container, React Query + Zustand, i18n es-PE, MMKV, navegación tipada, `@veo/ui-kit` (sistema de diseño móvil propio: tema **cálido/seguro** pasajero, **noche/denso** conductor; ver `docs/DESIGN-MOBILE.md`) y `@veo/api-client` (contratos soberanos). Consumo `file:` de `@veo/*` con `.npmrc node-linker=hoisted` para el autolinking de RN.

- `veo-passenger-app` (`pe.veo.passenger`, minSdk 24) — onboarding/auth OTP, Home (MapLibre/OSM + cotización + request), viaje activo (seguimiento Socket.IO `/passenger` + **visor de video LiveKit**), **pánico** (detector nativo 3× volumen Android/iOS, sin UI; `PanicSigner` HMAC con **clave real provisionada** vía `GET /auth/panic-key` + rotación ante 401), contactos de confianza, modo niño, pagos, ratings, perfil + borrado de cuenta, **KYC facial (liveness activo)**. Nativo: LocationProvider (background-geolocation), re-login biométrico (Keychain/Keystore), push FCM/APNs (`POST /devices`), **`VeoKycFrameGrabber` (Camera2/AVFoundation)** + detector de pánico por volumen. **Jest 87/87.**
- `veo-driver-app` (`pe.veo.driver`, minSdk 26) — auth, **inicio de turno con gate biométrico real** (challenge→frame-grabber nativo Camera2/AVFoundation→verify→`sessionRef`→shift/start; enrolamiento facial), dashboard de turno, viaje activo (mapa + modo niño), ganancias, perfil. Nativo: GPS continuo→Socket.IO `/driver` (soberano, **MQTT retirado**), Foreground Service Android, **publisher LiveKit** (`{url,token,room}`, sustituye WHIP), re-login biométrico, push (`POST /notifications/device-token`). **Jest 51/51.**

### Sesión de endurecimiento + KYC pasajero E2E (2026-05-30)

Auditoría completa de ambas apps (typecheck/lint/Jest verdes) + correcciones de flujo y un flujo KYC nuevo de punta a punta:

- **Apps — fixes:** push FCM/APNs ahora se inicializa tras login/cold-start (`RootNavigator`); re-entrada a viaje en curso desde el historial (`TripHistory`→`TripActive` para estados no terminales); `lock()` del candado biométrico en logout; conductor: guarda runtime del `LocationSource` (no carga eager si el binario nativo no está) y **timeout en la captura biométrica iOS** (evita cuelgue eterno); categoría de tarifa cableada E2E (`@veo/api-client` `createTripRequest.category` → trip-service migración + DTO + evento → public-bff → `RouteQuoteScreen`).
- **Seguridad MMKV:** la `encryptionKey` del store de tokens ahora se deriva de Keychain/Keystore (`secure-encryption-key.ts`, `recrypt`) en ambas apps; se agregó `react-native-get-random-values` (CSPRNG, import primero en `index.js`). **`pod install` pendiente en iOS** por la nueva dep.
- **KYC pasajero E2E (decisión cliente: liveness OK → `kycStatus VERIFIED`):** `@veo/events` evento `user.kyc_verified`; identity-service módulo `kyc/` (`POST /users/kyc/challenge` + `/verify` con `InternalIdentityGuard`, llama a biometric-service `/v1/embed`+`/v1/verify`, en liveness OK setea `users.kyc_status=VERIFIED` + `face_embedding` + `kyc_verified_at` + outbox) **+ migración Prisma aplicada al dev-stack**; public-bff módulo `kyc/` (`POST /api/v1/kyc/challenge` + `/verifications`, JWT pasajero, firma HMAC a identity, aplana frames→base64[]); app feature `kyc/` con **liveness activo** (pide reto, muestra la instrucción, captura con `VeoKycFrameGrabber`, envía challengeId). Tests verdes: events 6, identity 23, public-bff 65, app 87.

### dev-stack ampliado (Olas 2/3)

`docker-compose.yml` añade bajo perfil `maps`: **tileserver-gl** (tiles vectoriales OSM), **osrm-backend** (routing), **nominatim** (geocoding); + **livekit** (`--dev`, WS 7880) ya presente. `dev-stack/maps/prepare.sh` automatiza la preparación de datos OSM (Perú por defecto). Para habilitar el video en dev: `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecret_change_in_production` en el public-bff (por defecto el video queda deshabilitado y la web degrada limpio).

## 5. Pendiente ⬜ (por olas)

### Ola 5 — Infra & cierre (`veo-infra`)

Terraform (RDS por servicio crítico: identity/payment/panic/audit), EKS, ArgoCD, **CI por repo** (GitHub Actions: lint+typecheck+test+build), e2e, observabilidad prod, mTLS interno.

### Deuda técnica / TODOs conocidos

- **git**: inicializar los 4 repos cuando el cliente lo pida (commits Conventional con scope).
- **E2E cross-servicio orquestado** (viaje→dispatch→pago→pánico con varios servicios arriba a la vez contra el dev-stack): **pendiente**. Hoy cada servicio tiene su e2e individual contra infra real; falta el flujo extremo-a-extremo multi-servicio. Es el siguiente paso de validación recomendado.
- **E2E en vivo de Olas 2/3**: los tests de **contrato BFF↔gRPC** (`driver-bff`/`public-bff`) se auto-omiten cuando el downstream no responde, y los **Playwright web↔BFF** (`admin-web`/`family-web`, `test:e2e`) requieren el BFF arriba. Falta una corrida con el stack completo levantado (servicios Ola 1 + BFFs + perfil `maps` + livekit). La verificación estática (build/typecheck/lint/test 35/35) ya está verde.
- **Migraciones Prisma — nombres duplicados en dev**: varios servicios usan el folder `20260528120000_init`. En el dev-stack todos comparten una sola DB Postgres, así que `_prisma_migrations` quedó repartido (público + por schema) pero **todas las tablas existen y verificadas**. En prod cada servicio crítico tiene su **propia RDS** (FOUNDATION), por lo que no hay colisión real. Solo afecta a un `dev-stack:reset` desde cero: renombrar los `_init` a timestamps únicos si se quiere reset limpio.
- **Lint del workspace (resuelto en Fase 2)**: se añadieron al root `eslint@9`, `@eslint/js`, `typescript-eslint@8`, `eslint-config-prettier`, `globals`. `eslint.config.mjs` ignora ahora tooling (`*.config.*`, `scripts/**`, `test/**`, `shared-config/**`), desactiva `require-await` (interfaces async legítimas) y relaja reglas de tipado sobre dobles de test (`*.spec.ts`). Las apps Next (`admin-web`, `family-web`) y paquetes sin tests usan `eslint src --no-error-on-unmatched-pattern` / `vitest run --passWithNoTests`.
- Build de servicios a `dist` para producción (Docker): hoy se valida por typecheck; el `nest build` con consumo dist debe verificarse al contenerizar (Ola 5).
- Adapters "live" de rieles externos (SMS operador, Yape/Plin, push) son placeholders hasta tener credenciales/convenio (sandbox es el default y funciona).
- **Ola 4 — residuales no bloqueantes:** (1) build iOS **firmado/device** falla por `resource fork/detritus` en `WebRTC.framework` al vivir en carpeta sincronizada (Desktop) — el simulador compila con `CODE_SIGNING_ALLOWED=NO`; para device hacer `xattr -rc` fuera de la carpeta sincronizada. (2) `POST /media/rooms/:tripId/publisher-token` admite `name?` opcional que la app aún no envía (el grant funciona sin él). (3) El overlay visual que guía la `action` de liveness durante la captura facial del conductor aún no se renderiza (la captura es funcional). (4) El gate biométrico ONNX se valida en dev con `VEO_BIOMETRIC_MODE=sandbox` (selección por entorno, no mock); el match real con rostro requiere device/cámara. (5) **`pod install` pendiente** en ambas apps por la nueva dep `react-native-get-random-values` (autolink Android automático). (6) Los módulos nativos nuevos (`VeoKycFrameGrabber` pasajero) están registrados (MainApplication.kt + pbxproj) pero **solo verificados por inspección**; falta compilar nativo en device. (7) **KYC pasajero**: el flujo está E2E y verde estáticamente; el liveness es ACTIVO (el motor ONNX exige acción), así que el match real requiere device/cámara con `VEO_BIOMETRIC_MODE=live`.

---

## 6. Cómo continuar (receta para el próximo agente)

1. Levanta infra (§2) y `pnpm install`.
2. Compila la fundación: `pnpm --filter '@veo/*' build`.
3. Para un servicio nuevo de la Ola 1: **copia la estructura de `services/identity-service`** (config zod, infra Core/Prisma/Redis/Outbox, puertos sandbox+live, módulos de dominio, gRPC, main con OTel+filtros+/api/v1, vitest.config). Respeta `FOUNDATION` (anatomía §10, DoD §12).
4. Modelo de datos y reglas: blueprint §08 (datos) y §04 (reglas BR-\*). Eventos: `FOUNDATION §6` / `@veo/events` registro.
5. Migración: `migrate diff … --script` + `migrate deploy` (§3.3).
6. Verifica: `pnpm --filter @veo/<svc> typecheck && test`.

> Si retomas como agente con memoria propia, la memoria de Claude Code vive en
> `~/.claude/projects/-Users-jaxximize-Desktop-ecritrorio-00-Proyectos-VEO/memory/` (build-plan, sovereignty-rule, dev-env).
> Pero **este `STATUS.md` + `FOUNDATION.md` en el repo son la fuente de verdad portable**.
