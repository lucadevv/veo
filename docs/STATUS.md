# STATUS.md · Estado del proyecto y handoff

> **Documento de traspaso para cualquier agente (Claude, Cursor, etc.) o persona que retome VEO.**
> Última actualización: **2026-07-12**.
> Lee también, en este orden: `CLAUDE.md` (reglas no negociables) → `docs/FOUNDATION.md` (contrato técnico canónico,
> incluye §14 "Decisiones registradas") → este archivo (estado actual). El blueprint de negocio es `../VEO_Blueprint.pdf`.

---

## 0. TL;DR — ¿dónde estamos?

VEO es una plataforma de movilidad segura (Lima) en construcción desde el scaffold. **Monorepo** consolidado:
`veo-monorepo` (rama `develop`) reúne TODO en un solo repo — `apps/` (passenger, driver, admin-web, family-web, web-hub),
`services/` (16 microservicios + `bff/`) y `packages/` (`@veo/*`). Los repos viejos (`veo-platform`, `veo-passenger-app`,
`veo-driver-app`, `veo-infra`) **se consolidaron** acá; el framing multi-repo de versiones anteriores de este doc está obsoleto.

- ✅ **Ola 0 (Fundación)** — paquetes compartidos `@veo/*` construidos, compilados a `dist` y testeados.
- ✅ **Ola 1 COMPLETA** — los microservicios fundacionales + `@veo/maps` implementados para producción (sin mocks):
  - NestJS (`identity, trip, dispatch, payment, panic, media, notification, audit, rating, share, fleet`),
  - 1 Go (`tracking`), 1 Python/FastAPI+ONNX (`biometric`).
  - **Hoy hay 16 microservicios** en `services/` (excluyendo `bff/`): a los anteriores se sumaron **`chat-service`** (3014, chat in-app durante el viaje), **`places-service`** (3013, lugares guardados del pasajero) y **`booking-service`** (3016 REST / 50054 gRPC, cimiento del carpooling — ver §Carpooling abajo).
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
  - ✅ **(reconciliado 2026-07-12) El bono de incentivo YA entra al payout** — este bullet decía "gancho futuro" y estaba stale: `PayoutsService.collectEarnings` barre los bonos completados-no-pagados (`findUnpaidCompletedIncentives`, back-pay por arrastre) y los liga al Payout (`linkIncentivesToPayoutInTx`, guard anti doble-pago por `paidInPayoutId`); `paidAt` se marca al confirmar. Ver `payment-service/src/payouts/payouts.service.ts:1013` y suite `test/payouts-incentive.e2e.spec.ts`.
- ✅ **Ola 5 COMPLETA (infra + cierre)** — el deploy real es **VPS único + Docker Compose + GitHub Actions self-hosted** (§0.7(c)). Lo que está vivo:
  - **Deploy production-grade (carril VPS)**: `docker-compose.preview.yml` (stack completo production-grade) + `.github/workflows/images.yml` (build de imágenes a **GHCR** + deploy por **SSH al VPS**) + `infra/deploy/migrate-preview.sh` (migraciones Prisma en el host) + **Cloudflare Tunnel como edge** (NO CloudFront/ALB). Data stores self-hosteados en el VPS: **Postgres** (contenedor por servicio crítico identity/payment/panic/audit + 1 compartida) en vez de RDS; **MinIO con object-lock** en vez de S3+ObjectLock; **Kafka self-hosted** en vez de MSK; **Redis** en vez de ElastiCache; **cifrado app-level AES-256-GCM** (ya existe en código) en vez de KMS; **`.env`/docker-secrets/SOPS+age** en vez de Secrets Manager.
  - **~~Terraform (11 módulos AWS: vpc/eks/rds/msk/elasticache/s3/cloudfront/kms/iam/iot-core/secrets-manager) · EKS · ArgoCD · Linkerd+cert-manager · `kubectl kustomize` (114 objetos) · Atlantis/Spacelift · `terraform apply` · multi-AZ~~** — **SUPERSEDED por el modelo VPS (reemplazado por VPS, ver §0.7(c)).** El trabajo de IaC/K8s se conserva como historial pero **NO es el deploy real**: producción no usa AWS managed ni un cluster Kubernetes. La observabilidad self-hosted (Prometheus + Grafana + OTel Collector + Tempo + Loki/promtail) se opera en el VPS por Docker Compose, no por manifests K8s.
  - **CI por repo** (GitHub Actions): apps `veo-passenger-app`/`veo-driver-app` ahora tienen `ci.yml` (pnpm+Node22: lint+typecheck+test, build Android opcional; `@veo/*` resuelto vía GitHub Packages o checkout del hermano, gateado); `veo-platform` ci.yml/codeql cubren chat-service por glob. El pipeline de deploy es `images.yml` (build GHCR + deploy SSH al VPS).
  - **E2E cross-servicio orquestado** (`veo-platform/e2e/golden-path`): harness que levanta el stack mínimo (identity/trip/dispatch/payment/panic + public-bff + driver-bff) contra el dev-stack y corre el golden path (login pasajero→turno conductor con gate biométrico→crear viaje→dispatch→aceptar→FSM hasta COMPLETED→cobro+propina→**pánico HMAC con ack <3s**). **Corrido en vivo: 8/8 verde (~21s)**; `pnpm e2e:golden`. Resuelto el gap de build a `dist` (tsbuildinfo viejo + copia del cliente Prisma generado).
- 🔒 **Bloqueado por terceros (no es código pendiente):** Yape/Plin **live** (convenio+credenciales PSP; sandbox soberano funciona), **boleta/factura SUNAT** (proveedor OSE), **llamada con número enmascarado** (decidir telefonía/SIP — choca con soberanía).
- ✅ **git — consolidado a monorepo** — el trabajo vive ahora en **`veo-monorepo`** (rama de trabajo `develop`), que consolidó los repos viejos (`veo-platform`, `veo-passenger-app`, `veo-driver-app`, `veo-infra`) bajo el org `MarketrixPE`. `.gitignore` endurecido (sin node_modules/Pods/.cxx/datos de mapas/binarios Prisma/secretos). CI en GitHub Actions.

- ✅ **Carpooling / modo PROGRAMADO — backend + UI de ambas apps construidos (reconciliado 2026-07-03):**
  - **`booking-service` EXISTE y es el cimiento** (`services/booking-service`, REST 3016 / gRPC 50054, schema propio, migraciones del 2026-06-22..24). Dueño de **`PublishedTrip`** y **`Booking`** con sus máquinas de estado tipadas en `src/domain/` (`published-trip-state.ts`, `booking-state.ts`, `state-machine.ts` con `assertTransition`). Incluye **`cost-cap`** (tope de cost-sharing del pricing FIJO por país), **`payment-charge`** (cobro **charge-on-approval SIN hold** — corrección consciente al ADR-014: payment-service/Yape/Plin no tienen HOLD; se valida método al reservar + gate de DEUDA + estado DEBT), **`trip-segments`**, índices **H3** de búsqueda, clientes **gRPC** a fleet+identity, y **outbox** (con el relay de 3 fases ya aplicado). ADR canónico: `docs/adr/014-modelo-carpooling-booking-service.md`.
  - **Mapeo a las fases del plan (`specs/VEO_MODELO_HIBRIDO.md` §11):** **F0** (cimiento `PublishedTrip`/`Booking`) ✅ backend. **F1/F2** (publicar/buscar, server-side) ✅ endpoints en booking-service (`published-trips`, `bookings`). **F3** (reservar→aprobar→cobrar) ✅ **backend completo**: F3a borde de pago + gate de deuda, F3b aprobar/rechazar (driver-rail) + CHARGE al aprobar, F3c seat-lock atómico + consumer `payment.captured/failed` + refund automático con backstop observable.
  - ✅ **UI de carpooling en las apps — YA EXISTE (reconciliado 2026-07-03; este bullet decía lo contrario y estaba stale):** el pasajero tiene la feature completa (`apps/passenger/src/features/carpool/` + 5 pantallas registradas en `RootNavigator`: `CarpoolSearch`/`CarpoolResults`/`CarpoolTripDetail`/`CarpoolBookingReview`/`CarpoolBookingStatus`, frames del pen `P/ProgSearch`→`P/BookingRejected`) y el conductor puede publicar y gestionar reservas (`apps/driver/src/features/carpool/` + rutas `CarpoolPublish`/`CarpoolTripBookings`). `rg -l PublishedTrip apps/*/src` ya NO da vacío.
  - ✅ **Cableado en el dev-stack (reconciliado 2026-07-03):** `booking-service` arranca por el orquestador — `dev-stack/veo.sh` lo declara (`booking|3016|services/booking-service`) y `boot-extra-services.sh` lo levanta (`start_node booking … 3016`).

- 🛡️ **Endurecimiento reciente (verificado en el git log de `develop`, no exhaustivo):**
  - **KYC desacoplado de la aprobación** — el KYC del conductor se auto-verifica con los biométricos; **liveness PASIVO (PAD anti-spoofing single-frame)** en el enrol + binding contra DNI **Y** licencia; panel canónico de face-match en admin (commits `617a752`, `a8c5fbe`, `c3ee16a`, `f39bcd9`, `e7d6df3`, `6d2923e`, `273f9ba`).
  - **Suspensión del conductor refactorizada a HOLDS multi-causa** — auto-suspensión por ITV vencida, rating bajo y exceso de cancelaciones; reactivación cause-aware en el panel (commits `a353ee4`, `785bedc`, `6b55bad`, `8fbfd3d`); **gate de aprobación ITV** sobre el modelo `Inspection` de fleet (`8674165`).
  - **Outbox relay desacoplado de la tx/lock de Postgres** (claim-marker de 3 fases) + retención de filas publicadas (`0991cea`, `016e196`); **observabilidad transversal**: `domain_events_total` centralizada + `traceId` propagado a través del outbox (`2646225`, `6f78bb1`).
  - **Rate-limit / IP-spoofing endurecidos en los BFFs y audit-service** (`011f59c`); **hard gate de face-match** en la aprobación del conductor (`698c9ef`); **IDOR de moderación** cerrado en rating (`269382c`); **fleet consume `user.deleted`** para purgar la flota del conductor borrado (Ley 29733, `d5599d1`).
  - **Modelo de deploy = VPS** (ver §0.7(c)): se **eliminó** el carril AWS/k8s; prod = VPS único + Docker Compose + GitHub Actions self-hosted; `booking-service` ya cableado al carril VPS (`4e66a06`, `d7e5a10`, `7157d2c`).

- 🆕 **Modelo de pricing — COEXISTENCIA (ADR-023, 2026-07-07):** los 3 modos (**FIJO**=Uber · **PUJA**=inDrive · **COST-SHARE**=BlaBlaCar) COEXISTEN puros, asignados **por servicio a MANO por el admin** (palanca manual, sin franjas horarias — **ADR-011 superseded en su parte de schedule**). Una fórmula de distancia (`calculateFirmFare`, intacta) + params por servicio; **dos bordes honestos**: Mecánico = **call-out plano** (visita, no viaje: perKm=0 Y perMin=0, labor aparte), Carpooling = **producto propio** (`booking-service`, no "un modo del catálogo"). **Surge afuera** del modelo. Modo per-service reemplaza `allowedModes`+schedule (ADR-013 alineado). Plan de código: `specs/changes/pricing-taxonomy/` (Fases A/B, pendientes). Diseño en veo.pen (5 frames admin: On-demand · Viajes · Especiales · Carpooling · Detalle de servicio).
  - 🆕 **Ofertas CUSTOM (alta de servicio) — admin COMPLETO, consumo del pasajero PENDIENTE (2026-07-12):** el SUPERADMIN puede crear ofertas a medida desde el admin (`/finance/catalog` → "Nuevo servicio"). Vertical real end-to-end **verificado en vivo**: tabla `trip.CustomOffering` (id `custom_*`, mapea a un `vehicleClass`/`serviceType` EXISTENTE) + `@Post /internal/catalog/offerings` (trip-service, MFA+audit+outbox) → admin-bff `@Post /catalog/offerings` (`@Roles(SUPERADMIN)` + `catalog:create` (nuevo en `@veo/policy`) + step-up MFA) → api-client `createOfferingRequest` → `useCreateOffering` → `new-offering-dialog.tsx`. El catálogo (list/config/detalle) **une built-in ∪ custom**; el pricing/overlay/analytics las trata igual (validación extendida a enum∪custom en `OfferingOverrideDto`, `offering-metrics-query.dto`). Commit `14ae3149`/`6a77e204`.
    - **🔴 DEUDA para el agente de la APP (pasajero):** una oferta custom es 100% administrable pero el **pasajero AÚN NO la puede PEDIR**. `resolveTripOffering` (`trip-service/src/domain/offering.ts`) es puro/sync y usa `findOffering` (SOLO el enum) → un `createTrip` con `category: custom_*` da 400 `UNKNOWN_OFFERING`; el quote del public-bff queda gated por ahí. Cerrarlo: threadear el `CatalogService` (async, ya une built-in∪custom) en el seam de create-trip + el quote del pasajero. El MATCHING sí funcionaría (mapea a un `vehicleClass` existente). Secundario: `bid-floor.repository.parseOverrides` filtra por `findOffering` → una custom en PUJA usa el piso DEFAULT (su multiplier/minFare sí aplican).

- 🆕 **Gobierno del admin — modelo unificado de 4 capas (ADR-024 PBAC + ADR-025 Gobierno unificado, 2026-07-10):** el "quién puede qué" del admin ahora es una pila de 4 capas: **Roles** (enum, rango) → **Permisos base** (código, `PERMISSION_ROLES`) → **Overlay** (registro, **subtract-only**: solo RESTA permisos por-rol) → **Políticas/PBAC** (registro, condicional: IP-allowlist, session-idle, step-up MFA por política).
  - **`@veo/policy` (paquete nuevo) = FUENTE ÚNICA** de la matriz base `PERMISSION_ROLES` (antes vivía duplicada en `apps/admin-web/src/lib/rbac.ts`, que ahora **re-exporta** de `@veo/policy` para no romper imports). El mismo mapa que la UI usa para ocultar es el que el servidor enforcea. Incluye el catálogo `Permission`, el predicado `baseGrants`, el set de **candados legales no-restables** (`LEGAL_MANDATORY`: `audit:view`, `audit:verify`, `finance:payout` — el overlay NO puede ocultarlos en ningún rol, análogo al `mandatory` de una Política, Ley 29733) y la fórmula compartida del efectivo `base ∧ ¬oculto`.
  - **Registro server-side en `identity-service`** (módulo `policies`/gobierno): modelos Prisma **`Policy`** + **`PermissionOverride`**. Distribución a los BFFs por **Kafka** + **cache fail-safe** (sin dato del reader → no se resta nada; nunca afloja NI endurece de más un candado por un problema de lectura).
  - **Enforcement server-side** en `admin-bff` (`src/policies/`): `@Permission(...)` + **`PermissionOverlayGuard`** (efectivo `base ∧ ¬override`), **`IpAllowlistGuard`**, **`SessionIdleGuard`**, **`PolicyStepUpMfaGuard`**. Front compone `can()` = `base ∧ ¬hidden` (defensa en profundidad; la UI NO autoriza).
  - **UI**: sección **GOBIERNO** en admin-web con **Políticas** + **Permisos** (matriz interactiva subtract-only, con los candados legales pintados como no-restables).
  - **`media:approve` = EXCLUSIVO `[COMPLIANCE_SUPERVISOR, SUPERADMIN]`** (segregación de funciones Ley 29733: ADMIN SOLICITA pero NO APRUEBA). Verificado en `packages/policy/src/permissions.ts:100`, `admin-bff/media.controller.ts` y `media-service`.
  - **PENDIENTE / gaps honestos:** (1) ~~barrido endpoint→permiso~~ **~cerrado y auto-vigilado** (2026-07-12): el barrido `@Permission` se completó y lo enforcea `permission-overlay.enforcement.spec.ts` (test que falla si un handler admin queda sin mapear); restaban 2 handlers que otra misión de esta ola cierra hoy. (2) La feature de **export** que motiva el permiso net-new de F2 aún no existe. (3) El **wiring de `auth.stepup`** (drift de `maxAgeSec`) — **CERRADO también en `payment`/`trip`/`booking` (2026-07-12)**: los 3 registran `PolicyModule.forRootAsync` (patrón media-service) y `PayoutsService.hasFreshMfa` lee la ventana del mismo reader (fallback `STEP_UP_DEFAULT_MAX_AGE_SEC` de `@veo/auth`, se eliminó el 300 duplicado). (4) ADR-024/025 declaran "diseño sin código" en su header, pero el registro+overlay+`@veo/policy`+UI YA aterrizaron este sprint (los ADR individuales los mantiene otra sesión).

- 🛡️ **Audit de seguridad del admin-web + 9 fixes por severidad (2026-07-10):** revisión adversarial del auth/admin y correcciones: **four-eyes por IDENTIDAD** en media approve (`approverId ≠ requestedBy`), **panic resolve** con contrato `{resolution, notes?}` + persistencia real, **drift de step-up MFA** (el guard lee `auth.stepup.maxAgeSec`, no un literal), **`RolesGuard` ahora fail-CLOSED** (antes fallaba OPEN si un handler autenticado no declaraba `@Roles` → hoy `403 "Ruta sin @Roles declarado (fail-closed)"`, `@auth/guards/roles.guard.ts:30`) con **bypass `@Public` explícito** (login/health/csrf/ws-ticket/refresh), y los 3 guards de política (`IpAllowlistGuard`, `SessionIdleGuard`, `PolicyStepUpMfaGuard`) + `PermissionOverlayGuard`.

- 🧱 **Deuda repository FOUNDATION §10 pagada en toda la flota:** Prisma vive SOLO en `*.repository.ts`, transacciones vía unit-of-work `runInTx`; los servicios de dominio ya no tocan el cliente Prisma directo. Aplicado en `rating`/`payment`/`identity`/`trip` y el resto (ver git log `13fa6098`→`b5d59845`).

- ↩️ **Revertido:** el rename "Ofertas de servicio" → "Catálogo" se **deshizo** — "Catálogo" queda PROHIBIDO como label de UI (upholdea ADR-013).

- 💰 **FINANZAS admin — fidelidad pencil→web de las 3 secciones (2026-07-12):** pasada frame-first (números del `.pen`, medir vs vivo, **gating de seams reales — nada de fingir**, verificar en vivo a 1440). Metodología: cuando el frame es construible → fidelidad total; cuando el frame no tiene seam real → o se construye el seam, o se degrada honesto, o **el diseño se actualiza al código** (Direction B). Verificado en vivo con el harness dev nuevo (`veo.sh seed`/`login`, ver §2).
  - **Liquidaciones** (`/finance`) — **backend**: `payouts/stats` expone `paidCents`/`heldCents`/`failedCents` (money-por-bucket; la query ya sumaba por status y se descartaba); `getPayout` suma `bonusCents` (IncentiveProgress.paidInPayoutId); `GET /payouts/:id/trips` (viajes-incluidos, reconstruido por driver+período — el payout no persiste líneas); `GET /payouts/export` (CSV del filtro completo). **Frontend**: página-detalle rica `/finance/[id]` (frame `t5eZt`: NETO A PAGAR + breakdown bruto/comisión%/bono/deuda-CASH/neto, viajes incluidos reales, pago, historial derivado — honest-degrade de lo sin seam: método "Yape" fijo, sin "programado", timeline de 2-3 hitos); lista fiel (KPIs money, dropdown Estado, export, Período formateado). **Commiteado limpio**: `2f04d3cd`(payment) + `92d67e7b`(bff) + `0d7e600a`(admin-nuevos).
  - **Reembolsos** (`/finance/refunds`) — **rebuild a cola de aprobación** (money-OUT sensible). Repunteó de emisión-directa a **request→approve**: máquina de estados `RefundStatus` PENDING(cola, sin desembolsar)→APPROVED(desembolso en vuelo)→COMPLETED / REJECTED, con idempotencia (dedupKey) + step-up MFA + audit + dual-control por monto. Auto-refunds de sistema (`booking.cancelled`) nacen APPROVED (saltan la cola, no bloquean cancelaciones). Endpoints `GET /finance/refunds(+stats,+:id)`, `POST :id/approve|reject`, `POST :tripId`(crea PENDING). Frontend cola fiel al frame `HZ8uz` (KPIs, tabla, modales aprobar/rechazar). **146 tests** payment-service verdes. **LIMITACIÓN documentada**: mismo operador puede aprobar su propia solicitud (control = step-up + gate monto + audit, no dual-person estricto) — follow-up si se quiere segregación estricta.
  - **Reconciliación** (`/finance/reconciliation`) — **el código manda** (decisión): el frame diseñaba matching PER-TRANSACCIÓN (ref interna↔externa) pero el backend solo soporta AGREGADO per-corrida, y el transaccional está **BLOQUEADO** (ProntoPaga `getStatement()` devuelve `[]` en prod). Se agregó **estado honesto "Sin extracto del proveedor"** (`statementCount===0 && statementTotalCents===0 && dbTotalCents>0`) en vez del "Alerta 100%" engañoso; el path de alerta roja legítima queda para cuando el proveedor exponga el feed. El **`.pen` se actualizó** (frames `HykVT`/`YI0IS`) al modelo agregado real (tabla per-corrida + CompareRow), con el detalle marcado **épica futura** y el matching per-tx documentado como épica condicionada a un feed de extracto.
  - **UI global (design system)**: `table.tsx` → tabla como card elevado radio 16; `page-header.tsx`/`stat-card.tsx` → título + valor KPI en Space Grotesk (`font-display`) + gap 16 + iconos KPI coloreados por tono. Alinea el admin al `.pen` (los frames eran consistentes; el código había derivado por página) — afecta finance/audit/reconciliation/operators/drivers/trips.
  - **Commit / working tree**: solo el backend de Liquidaciones (`payouts/*`) se commiteó limpio. Reembolsos (backend+frontend), Reconciliación y el wiring de las listas quedan en el **working tree entreverado** con la migración de tema + trabajo de métricas en vuelo (mismos archivos compartidos: `payments.service.ts`, `finance.service.ts`, `api-client/{admin,types}.ts`, `queries.ts`) → se commitean junto con el tema como una foto coherente de `develop`.

**Lo siguiente:** backend y UI de carpooling están construidos y `booking-service` cableado al dev-stack (ver arriba). Para ir a producción real (carril VPS, §0.7(c)): bootstrap del VPS (Docker Engine + Compose + Cloudflare Tunnel), cargar secretos en el host (`.env`/docker-secrets/SOPS), `docker compose -f docker-compose.preview.yml up` + correr `infra/deploy/migrate-preview.sh`, activar el deploy SSH de `images.yml`, conectar los rieles bloqueados por terceros, y firmar/publicar las apps a las stores.

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
cd veo-monorepo                                                            # repo único (rama develop)
pnpm install
docker compose -f dev-stack/docker-compose.yml up -d postgres redis kafka   # infra mínima
# Orquestador de dev: dev-stack/veo.sh (levanta infra docker + servicios nativos + BFFs; booking-service YA cableado).
```

**Harness de dev (2026-07-12) — arranque + seed + login en un comando:**

```bash
veo.sh dev [--no-seed] [--seed-trips[=N]]  # levanta TODO + auto-siembra identity/driver/media al final del boot
veo.sh seed [identity|driver|media|trips]  # seeds dev idempotentes; `seed trips N` deja N viajes IN_PROGRESS por el PATH REAL de eventos (sim conductor + Kafka, no escribe el read-model a mano)
veo.sh login [--json]                      # auto-login: lee el TOTP vivo (:5190/api/otps), POST a admin-bff, imprime las cookies veo_at/veo_rt (httpOnly) listas para curl/chrome-devtools
```

- Credenciales dev: `admin@veo.pe` / `ChangeMe_VEO_2026!`; 6 operadores por rol (`admin-role`/`dispatcher`/`support-l1`/`support-l2`/`compliance`/`finance` @veo.pe, misma pass); TOTP fijo dev `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (visor en `:5190`).
- El seed barato (identity/driver/media) es idempotente y corre en cada `veo.sh dev`; `seed trips` es opt-in (orquestación viva ~90s). El módulo TOTP compartido vive en `dev-stack/lib/totp.mjs`.

**Quirks ya resueltos en `dev-stack/docker-compose.yml`** (importantes):

- **Postgres en host `5433`** (no 5432 — choca con otro proyecto local). `DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo`.
- **MinIO en host `9002`** (9000 choca con ClickHouse). MinIO self-hosted es el object store en dev y prod (NO S3 — §0.7(c)).
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
- `audit-service` (3009) — append-only + **MinIO object-lock** (self-hosted, NO S3 — §0.7(c)) + **hash chain** verificable. **19 tests** (incl. e2e). Schema `audit`.
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

Deploy carril VPS (§0.7(c)): `docker-compose.preview.yml` + `images.yml` (build GHCR + deploy SSH) + `migrate-preview.sh` + Cloudflare Tunnel. Postgres self-hosted por servicio crítico (identity/payment/panic/audit), **CI por repo** (GitHub Actions: lint+typecheck+test+build), e2e, observabilidad prod (Prometheus/Grafana/OTel/Tempo/Loki en el VPS). **~~Terraform/EKS/ArgoCD/mTLS-Linkerd~~ SUPERSEDED por el modelo VPS (reemplazado por VPS, ver §0.7(c)).**

### Deuda técnica / TODOs conocidos

- **git**: inicializar los 4 repos cuando el cliente lo pida (commits Conventional con scope).
- **E2E cross-servicio orquestado** (viaje→dispatch→pago→pánico con varios servicios arriba a la vez contra el dev-stack): **pendiente**. Hoy cada servicio tiene su e2e individual contra infra real; falta el flujo extremo-a-extremo multi-servicio. Es el siguiente paso de validación recomendado.
- **E2E en vivo de Olas 2/3**: los tests de **contrato BFF↔gRPC** (`driver-bff`/`public-bff`) se auto-omiten cuando el downstream no responde, y los **Playwright web↔BFF** (`admin-web`/`family-web`, `test:e2e`) requieren el BFF arriba. Falta una corrida con el stack completo levantado (servicios Ola 1 + BFFs + perfil `maps` + livekit). La verificación estática (build/typecheck/lint/test 35/35) ya está verde.
- **Migraciones Prisma — nombres duplicados en dev**: varios servicios usan el folder `20260528120000_init`. En el dev-stack todos comparten una sola DB Postgres, así que `_prisma_migrations` quedó repartido (público + por schema) pero **todas las tablas existen y verificadas**. En prod cada servicio crítico tiene su **propio Postgres self-hosted** en el VPS (contenedor dedicado vía Docker Compose, NO RDS — FOUNDATION §0.7(c)), por lo que no hay colisión real. Solo afecta a un `dev-stack:reset` desde cero: renombrar los `_init` a timestamps únicos si se quiere reset limpio.
- **Lint del workspace (resuelto en Fase 2)**: se añadieron al root `eslint@9`, `@eslint/js`, `typescript-eslint@8`, `eslint-config-prettier`, `globals`. `eslint.config.mjs` ignora ahora tooling (`*.config.*`, `scripts/**`, `test/**`, `shared-config/**`), desactiva `require-await` (interfaces async legítimas) y relaja reglas de tipado sobre dobles de test (`*.spec.ts`). Las apps Next (`admin-web`, `family-web`) y paquetes sin tests usan `eslint src --no-error-on-unmatched-pattern` / `vitest run --passWithNoTests`.
- Build de servicios a `dist` para producción (Docker): hoy se valida por typecheck; el `nest build` con consumo dist debe verificarse al contenerizar (Ola 5).
- Adapters "live" de rieles externos (SMS operador, Yape/Plin, push) son placeholders hasta tener credenciales/convenio (sandbox es el default y funciona).
- **Ola 4 — residuales no bloqueantes:** (1) build iOS **firmado/device** falla por `resource fork/detritus` en `WebRTC.framework` al vivir en carpeta sincronizada (Desktop) — el simulador compila con `CODE_SIGNING_ALLOWED=NO`; para device hacer `xattr -rc` fuera de la carpeta sincronizada. (2) `POST /media/rooms/:tripId/publisher-token` admite `name?` opcional que la app aún no envía (el grant funciona sin él). (3) El overlay visual que guía la `action` de liveness durante la captura facial del conductor aún no se renderiza (la captura es funcional). (4) El gate biométrico ONNX se valida en dev con `VEO_BIOMETRIC_MODE=sandbox` (selección por entorno, no mock); el match real con rostro requiere device/cámara. (5) **`pod install` pendiente** en ambas apps por la nueva dep `react-native-get-random-values` (autolink Android automático). (6) Los módulos nativos nuevos (`VeoKycFrameGrabber` pasajero) están registrados (MainApplication.kt + pbxproj) pero **solo verificados por inspección**; falta compilar nativo en device. (7) **KYC pasajero**: el flujo está E2E y verde estáticamente; el liveness es ACTIVO (el motor ONNX exige acción), así que el match real requiere device/cámara con `VEO_BIOMETRIC_MODE=live`.

#### Driver app — auditoría de fidelidad `.pen`↔RN, completitud de UI y trazabilidad (2026-07-12)

Auditoría módulo×módulo de `apps/driver` contra los frames del `design/veo.pen` (board Conductor `Bqk6u`), verificada en simulador iOS (iPhone 17 Pro Max @ Metro 8084). Muchos fixes ya se aplicaron y committearon (`d56c447c`, `ac500bc4`, `fbd16f58` en `develop`). Lo que sigue es la **deuda pendiente**, agrupada. Detalle vivo en engram/`MEMORY.md`.

- **A · Trazabilidad estática (mjolnir) — deuda de OBSERVABILIDAD, NO bug.** `get_verdict` reporta 1/47 journeys "cierran" (healthScore 2%) con **83/112 seams `untraceable` (BAJA) y 0 dead-ends**. Causa: el driver **auto-deriva la base del BFF del host de Metro** (base dinámica `this.http:/…`, `apps/driver/env/development.env` deja las URLs vacías) → el estático no cose `fetch`↔ruta backend. **Los flujos cierran en runtime** (corrido en vivo); `0 dead-ends` = ningún fetch a ruta inexistente. Para trazabilidad end-to-end en CI: `mjolnir ingest_traces` (runtime) o pinnear una base resoluble. `journey_coverage` queda inconclusa por lo mismo (87 test-refs existen; solo 1 journey evaluable estáticamente).

- **B · Completitud de UI (caminos infelices) — enumerado, parcialmente verificado en runtime.**
  - **Ganancias-Vacío NO implementado**: con cero ganancias renderiza las cards en `S/0.00` en vez del empty dedicado (`C/Ganancias-Vacio` = EmptyState + CTA "Conectarme"). `features/earnings/.../EarningsScreen.tsx`.
  - **Estados de turno colapsados en banners inline**, no los layouts dedicados del diseño: `C/ShiftStart-Error`, `C/Biometrico-Bloqueado`, `C/Cuenta-Suspendida` → faltan pill "te quedan N intentos", countdown de bloqueo, motivo de suspensión, CTA "Contactar a la central"/"Actualizar documentos" (varios son dead-ends de UI: CTA deshabilitado en bloqueo). `ShiftStartScreen.tsx`, `BiometricGate.tsx`, `DashboardScreen.tsx`.
  - **Runtime NO verificado** para los estados **vacío/error** de las tabs (Carlos R. tiene data; con esa cuenta no aparecen). Falta: cuenta aprobada-sin-actividad (vacíos) + inyección de fallo/BFF-down (errores) para fotografiarlos.

- **C · Fundación `@veo/ui-kit` (COMPARTIDO — afecta passenger, decidir con cuidado).**
  - **Colisión `surfaceElevated`===`surface`===`#FFFFFF`** en el theme light → discos de ícono / tracks / pill activa quedan invisibles (blanco sobre blanco). Tapado LOCAL con `skeleton` (`#E8ECF1`) en ~10 sitios (chart bars, segmented, discos de Cuenta/Documentos/Incentivos/Ayuda/Bookings, CierreTurno). Fix correcto: token **`surfaceMuted` (`#EEF1F5`)** en `ThemeColors` + migrar.
  - Falta **token de texto legible** para pills/valores de estado: `successText #00873A` / `warnText #B26A00` (hoy usa el brillante `#00C853`/`#FFA000` para el punto Y el texto → bajo contraste en blanco). Rebota en `StatusPill`, "COMPLETADO", montos, "+20%".
  - **Avatar fallback**: iniciales sobre disco brand-tinted (`#0075A916`) + ring `#DDE1E7`; hoy disco blanco + borderStrong.
  - **Glyphs faltantes**: `target`, `headset`, `badge-check`, `user-round-search` (se usaron proxies razonables).

- **D · Bloqueada por backend (gaps de contrato — degradación honesta hoy).**
  - **Contador de intentos**: ni `POST /auth/otp/verify` ni el gate biométrico (`/drivers/shift/biometric/verify`) devuelven `attempts`/`maxAttempts` → no se muestra "te quedan N intentos" (identity los cuenta server-side, no los expone).
  - **`lockedUntil`** en el 403 del bloqueo biométrico → falta para el countdown de reintento.
  - **Motivo de suspensión** de cuenta → falta en el status del driver.
  - **Geocoding**: direcciones reales en `TripDetailScreen`/carpool (el contrato solo trae lat/lng).
  - **PII del pasajero** (nombre/rating) no está en el contrato de trip/booking (regla #5, correcto) → cards adaptados sin PII.
  - **Editar Perfil**: no hay campo de contacto editable/persistible en `driver-bff` → email "No registrado" + CTA deshabilitado.
  - **Notificaciones**: falta tono `danger`/kind para "documento por vencer". **Incentivos**: falta el tipo "Racha de días" (streak) en el modelo de dominio (`ops`).

- **E · Sincronización diseño↔código (`.pen`).**
  - Los 3 frames **`C/Onboarding` del `veo.pen` siguen dark full-bleed**; el código se migró a **light** (foto arriba fundiéndose al lienzo claro) por decisión del dueño → **sincronizar los frames** para que diseño↔código no queden separados.
  - **Módulo 2 `UnderReviewScreen`**: restos pre-Trust **dark en el CÓDIGO** (ETA card azul en vez de ámbar `warn`, escudo azul en vez de cyan `info`) — se construyó contra el frame dark viejo. `UnderReviewScreen.tsx:138,166-186`.

- **F · Módulo 4 (Viaje) — SIN auditar.** Todo el flujo de viaje (TripIncoming/Active/Complete, Puja, SOS, navegación) está **detrás del gate biométrico**, que no pasa en el simulador (liveness/cámara real). Queda sin cruzar contra los frames; requiere bypass de dev del gate o verificación en device.

- **G · Reuso/limpieza (mjolnir, baja prioridad).** `clones-estructurales`: boilerplate repetido de hooks React Query (`useTrip`/`useDocuments`/`useEarningsSummary`…) — arquitectural. `valor-hardcodeado`: `#1A2332` (sombra) + `rgba(255,255,255,0.92/0.96)` (tab bar/GlassSheet frosted) — excepciones documentadas (usar `hexAlpha`). `pantalla-huerfana`: `CarpoolScreen` (tab Compartir) — technicality del grafo de nav; reachable y verificada en vivo.

#### Deuda frontend passenger (features sin seam a backend)

Features de UI de `apps/passenger` construidas pero **sin seam a backend**, o data que hoy es estática y debería ser dinámica (server-driven). Cada fila: qué falta + el endpoint/dato a pedirle al backend + el `file:line` del marcador en código.

| # | Deuda | Marcador (file:line) | Qué falta / qué pedirle al backend |
|---|-------|----------------------|-------------------------------------|
| 1 | OTP por WhatsApp | `i18n/es-PE/common.ts:188` | El copy dice "por WhatsApp" pero el envío real es SMS (SMPP). Backend debe entregar por **WhatsApp Business API** como canal primario. |
| 2 | Rutas populares carpool | `carpool/.../CarpoolSearchScreen.tsx:49` | Endpoint `GET /carpool/popular-routes` (hoy hardcodeado). |
| 3 | Filtros/orden carpool | `carpool/.../CarpoolResultsScreen.tsx:37` | Que `POST /carpool/search` acepte **sort** (precio/salida) + **filtro** (verificado). |
| 4 | Chat carpool | `carpool/.../CarpoolBookingStatusScreen.tsx:55` | Canal `/carpool/bookings/:id/messages`. |
| 5 | Control de cámara (preferencia) | `trip/domain/cameraShareRepository.ts:9` | Persistir "quién ve mi cámara" server-side (hoy MMKV local); `media-service` la aplica al autorizar viewers. |
| 6 | Idioma y región | `profile/.../ProfileScreen.tsx:85` | Multi-locale + persistir preferencia de idioma (hoy solo es-PE). |
| 7 | Términos y privacidad | `profile/.../ProfileScreen.tsx:88` | URL legal (Ley 29733) en config/env. |
| 8 | Accesibilidad | `profile/.../ProfileScreen.tsx:83` | Pantalla de ajustes de accesibilidad de la app. |
| 9 | Fee "Cargo por servicio S/3" carpool | `carpool/.../CarpoolBookingReviewScreen.tsx:48` | El `.pen` lo inventa; **decisión de producto** (backend agrega el fee al desglose) o corregir el `.pen`. |
| 10 | Email login/register | `auth/data/httpAuthRepository.ts:70` | Cableado en datos+BFF pero **sin pantalla** en passenger (falta `EmailLoginScreen`). |
| 11 | Modo niño fee | `childMode/.../ChildModeScreen.tsx` (~L204) | `CHILD_MODE_FEE_CENTS` debería ser **server-driven** (p.ej. `GET /maps/catalog` o `GET /pricing/child-mode`) para cambiar la tarifa sin release. |

> Verificado con mjolnir (seams) + audit de código. Los **WIRED** confirmados (NO deuda): OAuth Google/Apple, notif-prefs sync, Promociones. Navegación: **58/58 journeys cierran (0 dead-ends)**.

---

## 6. Cómo continuar (receta para el próximo agente)

1. Levanta infra (§2) y `pnpm install`.
2. Compila la fundación: `pnpm --filter '@veo/*' build`.
3. Para un servicio nuevo de la Ola 1: **copia la estructura de `services/identity-service`** (config zod, infra Core/Prisma/Redis/Outbox, puertos sandbox+live, módulos de dominio, gRPC, main con OTel+filtros+/api/v1, vitest.config). Respeta `FOUNDATION` (anatomía §10, DoD §12).
4. Modelo de datos y reglas: blueprint §08 (datos) y §04 (reglas BR-\*). Eventos: `FOUNDATION §6` / `@veo/events` registro.
5. Migración: `migrate diff … --script` + `migrate deploy` (§3.3).
6. Verifica: `pnpm --filter @veo/<svc> typecheck && test`.

> Si retomas como agente con memoria propia, la memoria persistente (engram) y el `MEMORY.md` del proyecto guardan el detalle
> vivo de las últimas sesiones (carpooling, holds de suspensión, outbox, KYC pasivo, deploy VPS, etc.).
> Pero **este `STATUS.md` + `FOUNDATION.md` en el repo son la fuente de verdad portable**.
