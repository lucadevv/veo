# FOUNDATION.md · Contrato canónico de construcción

> **Fuente de verdad para CUALQUIER agente o persona que escriba código en `veo-platform`.**
> Antes de implementar un servicio, paquete, BFF o frontend, lee este documento completo.
> Si algo aquí contradice tu intuición, **gana este documento**. Si algo no está cubierto, sigue el
> servicio de referencia (`services/identity-service`) y deja un comentario `// FOUNDATION?:`.

Complementa a `CLAUDE.md` (reglas no negociables) y al blueprint (`../VEO_Blueprint.pdf`, lógica de negocio).
Las reglas de negocio se referencian por ID: **BR-T0x** (viaje), **BR-I0x** (identidad), **BR-P0x** (pago),
**BR-S0x** (seguridad/compliance), **BR-D0x** (conductor). Ver blueprint §04.

---

## 0. Principios

1. **Nada de mocks en el dominio.** La lógica de negocio se implementa de verdad: máquinas de estado,
   idempotencia, cálculo de tarifas/comisiones, validaciones. Lo único "no real" permitido es el
   **modo sandbox de proveedores externos** (§9) — y aun así detrás de un adapter de producción.
2. **Sin `any`.** ESLint lo marca. Usa `unknown` + narrowing o tipos del dominio (`@veo/shared-types`).
3. **Cada servicio es dueño de sus datos.** Schema Postgres propio. **Prohibido** join cross-servicio o
   leer la tabla de otro servicio. Comunicación: **eventos Kafka** (asíncrono) o **gRPC/HTTP** (síncrono).
4. **Idempotencia donde hay efectos.** Pagos y pánico llevan `dedupKey`. Outbox para publicar eventos.
5. **Observabilidad antes que features.** Todo endpoint: log estructurado + métrica + span de trace.
6. **Tests de reglas de negocio obligatorios.** No para getters; sí para state machine, dispatch, panic
   fan-out, idempotencia de pago, RBAC, validación de código de modo niño.
7. **🔒 SOBERANÍA TECNOLÓGICA (regla maestra del cliente).** Soberanía = **control del DATO y el CÓMPUTO
   sensibles** (seguridad y privacidad bajo Ley 29733), NO "cero proveedores". **El dato/cómputo sensible
   — biometría, video en vivo, pánico, audit inmutable, PII — se construye propio / self-hosted y NUNCA se
   entrega a un tercero.** En cambio, los **rieles de transporte físicamente externos e inevitables** (red de
   pagos Yape/Plin, **push FCM/APNs de Google/Apple**, entrega de SMS por operador) **SÍ se usan** — son
   plomería, no dato soberano (a APNs tampoco lo self-hosteás). Reglas para usarlos: **(a)** detrás de un
   **puerto propio intercambiable** (`interface` + adapter + sandbox); **(b)** **sin PII en el payload** que
   viaja por el riel externo (mandá IDs / deep-links; el contenido sensible se resuelve en el cliente o tras
   auth). Usar **librerías open-source self-hosted NO cuenta como "dependencia"** (NestJS, Prisma, OSRM,
   LiveKit self-hosted, ONNX runtime son válidos). Esto **reescribe el blueprint** en lo que SÍ es soberano:
   biometría propia (NO FaceTec/Onfido), mapas/routing OSM propios (NO Google Maps para el dato), WebRTC
   LiveKit **self-hosted** (el video NUNCA sale de nuestra infra).

---

## 1. Layout del monorepo

```
packages/        librerías compartidas (publicadas como @veo/* vía workspace:*)
  shared-types/  interfaces de dominio + enums (YA EXISTE, no romper)
  shared-config/ eslint/tsconfig/jest/prettier presets (YA EXISTE)
  utils/         errores, dinero, geo/H3, crypto, dedup, result, validación
  events/        envelope + schemas Zod de eventos + producer/consumer Kafka + outbox
  auth/          JWT (jose), guards/decorators NestJS, RBAC, step-up MFA, HMAC firma
  observability/ logger pino, OTel bootstrap, métricas prom-client, interceptors, health
  database/      PrismaService factory (schema-per-servicio), helpers tx/outbox, testcontainers
  api-client/    SDK TS generado desde OpenAPI (Ola 3, frontends)
  ui-kit/        componentes RN compartidos (Ola 4)
  maps/          @veo/maps — cliente OSM propio (OSRM/Valhalla routing + Nominatim geocoding), cache Redis
services/        14 microservicios (12 NestJS + tracking en Go + biometric en Python) + bff/{admin,driver,public}-bff
apps/            admin-web (Next.js), family-web (Next.js)
```

> **Servicios añadidos por las decisiones del 2026-05-28** (ver §14): `fleet-service` (vehículos, documentos,
> vencimientos, inspecciones — separado de identity), `biometric-service` (Python/FastAPI + ONNX: detección,
> embeddings, liveness, match — motor biométrico PROPIO). Paquete nuevo `@veo/maps` (fachada OSM self-hosted).

`tsconfig.base.json` mapea los paths `@veo/*` → `packages/*/src` (para typecheck/tests **dentro de** packages).

**Resolución cross-paquete (regla de monorepo — importante):** los servicios consumen los `@veo/*`
**compilados desde `dist`** (no el source), porque el `rootDir` del servicio no puede contener el source de otro paquete.
Por eso: (a) cada `@veo/*` package.json apunta `main`→`dist/index.js`, `types`→`dist/index.d.ts`, `exports`→dist;
(b) el `tsconfig.json` de cada **servicio** incluye `"paths": {}` para anular los paths del base y resolver vía
`node_modules` → dist. **Consecuencia:** antes de typechec­kear/testear un servicio hay que **construir sus
dependencias** (`turbo` ya lo hace con `dependsOn: ["^build"]`; si corres `pnpm --filter` directo, ejecuta antes
`pnpm --filter '@veo/*' build` o usa el comando turbo). Los paquetes son `composite: true`.

---

## 2. Puertos (fijos, no inventar)

| Rango | Uso |
|---|---|
| 3001–3099 | microservicios |
| 4001–4099 | BFFs |
| 5000+ | frontends |

| Servicio | Puerto |
|---|---|
| identity-service | 3001 |
| trip-service | 3002 |
| dispatch-service | 3003 |
| tracking-service (Go) | 3004 |
| payment-service | 3005 |
| panic-service | 3006 |
| media-service | 3007 |
| notification-service | 3008 |
| audit-service | 3009 |
| rating-service | 3010 |
| share-service | 3011 |
| fleet-service | 3012 |
| places-service | 3013 |
| chat-service | 3014 |
| biometric-service (Python/FastAPI) | 3015 |
| public-bff | 4001 |
| driver-bff | 4002 |
| admin-bff | 4003 |
| admin-web | 5000 |
| family-web | 5001 |

Infra local (dev-stack): Postgres `5432`, Redis `6379`, ClickHouse `8123/9000`, Kafka `9094`,
MinIO/S3 `9002` (API) + `9001` (consola), Mosquitto MQTT `1883`, LiveKit `7880`, Mailpit `1025/8025`,
Jaeger OTLP `4317/4318` UI `16686`, Prometheus `9090`, Grafana `3001→host` (ver compose, expuesto en host `3001`).
> ⚠️ Grafana expone host `3001`, que colisiona con identity-service. En local, corre servicios fuera de Docker;
> si necesitas Grafana, no hay choque real porque identity corre en tu host y Grafana en su contenedor mapeado
> a host 3001 **solo si lo levantas**. Para evitar confusión: deja Grafana apagado salvo que lo necesites.

---

## 3. Modelo de errores (`@veo/utils`)

Jerarquía única de errores de dominio. **Los servicios lanzan estos**, nunca `throw new Error('...')` crudo
en lógica de negocio. Un `ExceptionFilter` global (en `@veo/observability`) los mapea a HTTP/gRPC + log.

```ts
// @veo/utils/errors
export abstract class DomainError extends Error {
  abstract readonly code: string;       // 'TRIP_INVALID_TRANSITION'
  abstract readonly httpStatus: number; // 409
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) { super(message); this.details = details; }
}
export class ValidationError extends DomainError { code='VALIDATION'; httpStatus=400; }
export class UnauthorizedError extends DomainError { code='UNAUTHORIZED'; httpStatus=401; }
export class ForbiddenError extends DomainError { code='FORBIDDEN'; httpStatus=403; }
export class NotFoundError extends DomainError { code='NOT_FOUND'; httpStatus=404; }
export class ConflictError extends DomainError { code='CONFLICT'; httpStatus=409; }       // idempotencia
export class InvalidStateError extends DomainError { code='INVALID_STATE'; httpStatus=409; } // state machine
export class RateLimitError extends DomainError { code='RATE_LIMIT'; httpStatus=429; }
export class ExternalServiceError extends DomainError { code='EXTERNAL'; httpStatus=502; }
```

Servicios pueden subclasear con `code` específico (ej. `class InvalidTripTransition extends InvalidStateError`).
Respuesta HTTP de error siempre: `{ error: { code, message, details?, traceId } }`.

---

## 4. Config (`@nestjs/config` + Zod)

Cada servicio valida su env al boot con un schema Zod. Si falta una var requerida, **el servicio no arranca**.

```ts
// services/<svc>/src/config/env.schema.ts
import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  KAFKA_BROKERS: z.string(),
  LOG_LEVEL: z.enum(['debug','info','warn','error']).default('info'),
  // ...vars propias del servicio
});
export type Env = z.infer<typeof envSchema>;
```

Registrar con `ConfigModule.forRoot({ isGlobal:true, validate: (c)=>envSchema.parse(c) })`.
Acceder vía `ConfigService<Env, true>`. **Nunca** `process.env.X` directo en lógica de negocio.

---

## 5. Observabilidad (`@veo/observability`)

API pública que debe exportar:
- `createLogger(service: string)` → pino logger con redacción de PII (`phone`, `dni`, `password`, `token`, `email` → `[REDACTED]`).
- `LoggerModule` (NestJS) + `LoggingInterceptor` (log de cada request: método, ruta, status, latencia, traceId).
- `bootstrapOtel(serviceName)` → inicializa OpenTelemetry NodeSDK (OTLP a `OTEL_EXPORTER_OTLP_ENDPOINT`),
  auto-instrumenta http/express/kafkajs/pg. Llamar **antes** de crear la app Nest.
- `metricsRegistry` (prom-client) + `MetricsModule` que expone `GET /metrics`. Histograma estándar
  `http_request_duration_seconds{service,method,route,status}` y counter `domain_events_total{event,result}`.
- `AllExceptionsFilter` → mapea `DomainError`→status+body, loguea con traceId, incrementa `errors_total`.
- `HealthController` base: `GET /health` (liveness) y `GET /health/ready` (readiness: DB + Kafka + Redis).

Todo servicio en `main.ts`: `bootstrapOtel('trip-service')` → crear app → `helmet`, `ValidationPipe({whitelist,transform})`,
`setGlobalPrefix('api')`, montar `AllExceptionsFilter`, `LoggingInterceptor`, Swagger en `/docs`, `enableShutdownHooks()`.

---

## 6. Eventos & Kafka (`@veo/events`)

**Envelope único** para todo evento de dominio:

```ts
export interface EventEnvelope<T> {
  eventId: string;        // UUIDv7
  eventType: string;      // 'trip.requested'
  occurredAt: string;     // ISO-8601
  producer: string;       // 'trip-service'
  traceId?: string;       // propagación de trace
  dedupKey?: string;      // idempotencia
  schemaVersion: number;  // 1
  payload: T;             // validado por Zod
}
```

- Cada evento tiene un schema Zod en `@veo/events/schemas/<domain>.ts` + tipo TS inferido.
- Naming: `<domain>.<pastTense>` → `trip.requested`, `driver.verified`, `panic.triggered`, `payment.captured`.
- Topics Kafka = nombre del domain (`trip`, `payment`, `panic`, …) con key = id de la entidad raíz (para orden por entidad).
- Exporta `KafkaProducer` y `KafkaConsumer` wrappers tipados sobre `kafkajs`:
  `producer.publish(envelope)` valida con Zod antes de enviar; `consumer.on(eventType, handler)` valida al recibir.
- **Outbox pattern obligatorio** para servicios que mutan Postgres y publican: la mutación de dominio y el
  insert en tabla `outbox` ocurren en la **misma transacción**; un relay publica a Kafka y marca `published_at`.
  `@veo/database` provee el helper de outbox; `@veo/events` el relay. Catálogo completo de eventos: §6 del blueprint.

Eventos mínimos por servicio (publicar exactamente estos, ampliar si el dominio lo exige):
`user.registered`, `driver.verified`, `biometric.failed` (identity) · `trip.requested/assigned/accepted/started/completed/cancelled`
(trip) · `dispatch.match_found/timeout` · `driver.location_updated/entered_zone` (tracking) ·
`media.recording_started/archived` · `payment.captured/failed`, `payout.processed` · `panic.triggered/acknowledged` ·
`notification.delivered/failed` · `rating.created`, `driver.flagged` · `share.link_generated/viewed`.

---

## 7. Auth & RBAC (`@veo/auth`)

- JWT con **jose** (no `jsonwebtoken`). Access **15m**, refresh **30d** (BR/CLAUDE regla 5). Firma EdDSA/RS256 con
  claves de `JWT_*` env. Claims: `sub` (userId), `typ` ('passenger'|'driver'|'admin'), `roles` (AdminRole[]), `sid` (sessionId).
- Exporta: `signAccessToken`, `signRefreshToken`, `verifyToken`, `JwtAuthGuard`, `RolesGuard`,
  `@CurrentUser()`, `@Roles(...AdminRole[])`, `@Public()`, `StepUpMfaGuard` (BR-S07: video/RBAC/payout>S/5K exigen MFA fresca).
- `@CurrentUser()` inyecta `{ userId, type, roles, sessionId }`.
- 7 roles admin en `AdminRole` (ya en `@veo/shared-types`): SUPPORT_L1/L2, COMPLIANCE_SUPERVISOR, DISPATCHER, FINANCE, ADMIN, SUPERADMIN.
- `signHmac(payload, secret)` / `verifyHmac` para firma de requests de pánico (BR-S04, flujo §06 blueprint).

---

## 8. Base de datos (`@veo/database` + Prisma)

- **Dev:** Postgres único, schema lógico por servicio (dev-stack crea: identity, trip, payment, panic,
  notification, audit, rating, share, media; **falta agregar `fleet`** al `init-postgres.sql`).
  **Prod (decisión 2026-05-28):** instancia RDS dedicada por servicio crítico (identity, payment, panic, audit);
  el resto comparte una instancia. El código no cambia (cada servicio usa su `DATABASE_URL`).
- Cada servicio tiene **su propio** `prisma/schema.prisma` con:
  ```prisma
  generator client { provider = "prisma-client-js"; output = "../src/generated/prisma" }
  datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
  // models con @@schema("trip")  ← usar previewFeatures = ["multiSchema"]
  ```
  `generator` y `datasource` con `previewFeatures = ["multiSchema", "postgresqlExtensions"]`, `schemas = ["trip"]`.
- Migraciones: `prisma migrate dev` en local, `prisma migrate deploy` en CI/prod. Script `db:migrate` por servicio.
- `@veo/database` exporta (ya construido): `ReadWriteClient<T>` (**read/write split** primary/replica — usar
  `db.write` para escrituras y lecturas post-write críticas, `db.read` para el resto), `enqueueOutbox(tx, envelope, aggregateId)`
  + `PrismaOutboxStore` + `OUTBOX_PRISMA_MODEL` (modelo Prisma a incluir en cada schema), `tombstone()` + `deletedPlaceholder()`
  (BR-S06 derecho al olvido = **tombstone + anulación de PII**), y en `@veo/database/testing`: `createTestDatabase()`
  (testcontainers — **no mockear DB en payments/panic/audit**, CLAUDE).
- Tipos `Date`→`timestamptz`; dinero en **enteros de céntimos** (`fareCents`), nunca float. Moneda siempre `PEN`.
- IDs: UUIDv7 (`@veo/utils` provee `uuidv7()`).

---

## 9. Capacidades externas — bajo la regla de SOBERANÍA (§0.7)

VEO **construye propio / self-hosted todo lo posible**. Solo los rieles físicamente externos se conectan,
y siempre tras un puerto propio. Mapa de capacidades:

| Capacidad | Cómo en VEO | Tipo |
|---|---|---|
| Biometría (liveness + match) | **`biometric-service` PROPIO** (Python/FastAPI + ONNX open-source). identity orquesta vía puerto. | self-hosted |
| Video en vivo (WebRTC) | **LiveKit self-hosted** en EKS (open-source). El video nunca sale de nuestra infra. | self-hosted |
| Mapas/routing/geocoding | **OSM propio**: OSRM/Valhalla + Nominatim self-hosted, vía `@veo/maps`. | self-hosted |
| Validación DNI (RENIEC) | Fase 4. Ahora revisión manual del operador. Puerto `IdentityValidator` + sandbox. | externo (F4) tras puerto |
| Antecedentes (PJ) | Fase 4. Ahora subida + revisión manual. Puerto `BackgroundCheckProvider`. | externo (F4) tras puerto |
| Pagos Yape/Plin | Riel bancario inevitable. Conector mínimo tras puerto `PaymentGateway` + sandbox. | externo tras puerto |
| Push móvil FCM/APNs | Lo exige el OS (Google/Apple). Conector tras puerto `PushSender` + sandbox. | externo tras puerto |
| SMS (OTP, alerta familia) | Operador celular. Conector tras puerto `SmsSender` + sandbox (consola en dev). | externo tras puerto |

Patrón de puerto para **toda** capacidad externa (incluido el sandbox para las propias en dev):

```
domain/<thing>.port.ts         interface (puerto) — lo que el dominio necesita
adapters/<impl>.adapter.ts     implementación real (servicio propio / conector del riel externo)
adapters/sandbox.adapter.ts    implementación determinista para dev/CI (sin cuentas/infra real)
<thing>.module.ts              provee el adapter según VEO_<DOMAIN>_MODE = 'live' | 'sandbox'
```

- El sandbox **no es un mock de tests**: es un adapter de primera clase, seleccionable por env, con comportamiento
  determinista y realista (ej. `SmsSandboxSender` imprime el OTP en consola; `PaymentSandboxGateway` confirma tras delay).
- Credenciales **solo** por env / AWS Secrets Manager. Nunca en git. `.env.example` documenta cada var (ya está).
- Default local: `*_MODE=sandbox`. Prod: `live`. El código de dominio no sabe cuál corre.
- **Prohibido** entregar a un tercero el **dato/cómputo sensible** que se pueda self-hostear (biometría, video,
  pánico, audit, PII) (§0.7). Los **rieles de transporte externos inevitables** (push FCM/APNs, pagos, SMS) SÍ se
  usan, tras puerto propio y **sin PII en el payload**. Ante la duda, preguntar.

---

## 10. Anatomía de un servicio (idéntica en los 12)

```
services/<svc>/
  prisma/schema.prisma
  src/
    main.ts                  bootstrap (§5)
    app.module.ts            imports: ConfigModule(validate), LoggerModule, MetricsModule, DatabaseModule, + feature modules
    config/env.schema.ts
    common/health.controller.ts   (extiende base de @veo/observability)
    <feature>/
      <feature>.controller.ts      HTTP (REST) — DTOs con class-validator
      <feature>.grpc.controller.ts gRPC si otro servicio lo llama síncrono
      <feature>.service.ts         lógica de dominio (state machine, reglas BR-*)
      <feature>.repository.ts      acceso Prisma (sólo aquí se toca la DB)
      dto/                         class-validator DTOs in/out
      <feature>.events.ts          publicación de eventos (vía outbox)
      <feature>.service.spec.ts    tests de reglas de negocio
  test/<feature>.e2e-spec.ts       e2e con testcontainers para flujos críticos
  Dockerfile  nest-cli.json  package.json  tsconfig.json  README.md  docs/events.md
```

- **Controllers** finos: validan DTO, delegan al service, mapean salida. Sin lógica.
- **Services** contienen las reglas. Lanzan `DomainError`. Publican eventos vía outbox.
- **Repositories** son el único lugar con Prisma. Devuelven entidades de dominio, no modelos Prisma crudos en la API pública.
- gRPC entre servicios: protos en `protos/` (ya existe la carpeta). mTLS en prod (CLAUDE regla compliance).

---

## 11. Testing

- **Unit (vitest en packages y en servicios):** reglas de negocio. Cobertura de state machine al 100% de transiciones.
  (Decisión: **vitest también en servicios** — los `@veo/*` son ESM y jest+ESM en monorepo da fricción; vitest lo maneja nativo.
  Los servicios traen `vitest.config.ts` + script `test: vitest run`. Tests construyen las clases directamente, sin Nest DI.)
- **Integración/e2e:** flujos críticos (request→complete trip, panic fan-out, payment idempotencia, child-code, video doble-auth)
  con **testcontainers** (Postgres real, Redis real). Prohibido mockear DB en payments/panic/audit (CLAUDE).
- Casos adversariales obligatorios en pánico/KYC/video: timeouts, retries, red flaky, doble submit con misma dedupKey.
- `pnpm typecheck` y `pnpm lint --max-warnings 0` deben pasar. CI los bloquea.

---

## 12. Definition of Done (por servicio)

- [ ] `prisma/schema.prisma` con modelos del dominio (ver blueprint §08 modelo de datos) + migración inicial.
- [ ] Todos los endpoints F1 del inventario (blueprint §03) para ese dominio, con DTOs validados y OpenAPI.
- [ ] Reglas BR-* del dominio implementadas y testeadas.
- [ ] Eventos del §6 publicados vía outbox; consumidores registrados donde aplique.
- [ ] Adapters externos con modo live+sandbox (si aplica).
- [ ] Logs estructurados + métricas + health/ready.
- [ ] `pnpm --filter @veo/<svc> typecheck && lint && test` verde.
- [ ] `README.md` (qué hace, endpoints, eventos) y `docs/events.md` actualizados.

---

## 13. Commits

Conventional Commits con scope (`commitlint.config.cjs`). Ej: `feat(trip): máquina de estados REQUESTED→COMPLETED`.
No commitear binarios ni `.env`. Co-autoría según política del repo.

---

## 14. Decisiones de arquitectura registradas (2026-05-28)

Estas decisiones son **vinculantes** para toda la construcción. Cualquier agente las respeta sin re-preguntar.

**Regla maestra — Soberanía (§0.7):** todo propio/self-hosted; rieles externos inevitables tras puerto + sandbox.

**Estrategia de construcción:** amplitud backend — Ola 0 fundación ✅ → Ola 1 los servicios en paralelo →
Ola 2 BFFs → Ola 3 webs → Ola 4 apps RN → Ola 5 infra+e2e. Fundación hecha a mano; Ola 1 con `identity-service` como plantilla.

**Auth (`@veo/auth`, construido):**
- JWT **ES256**. Access 15m / refresh 30d.
- Refresh con **rotación + store Redis** (revocable al instante; reuse detection → mata la sesión).
- Validación **solo en el BFF**; el BFF propaga identidad firmada HMAC (`InternalIdentityGuard`) a los servicios.
- Step-up **TOTP** para acciones sensibles (BR-S07).
- Login: pasajero = phone+OTP **SMS**; conductor = phone+OTP + **liveness de turno**; admin = email + password **argon2id** + TOTP.
- **Biometría local** del dispositivo (Face ID/huella) opcional para re-login (refresh en Secure Enclave/Keystore).

**Datos (`@veo/database`, construido):** read/write split desde el inicio; derecho al olvido = **tombstone + anulación de PII**;
prod = instancia RDS por servicio crítico (identity/payment/panic/audit); DNI = **solo hash** (nunca en claro); testcontainers para tests críticos.

**Capacidades propias (§9):** biometría = **`biometric-service` Python/ONNX propio** (liveness activo por reto + match ≥90%,
embeddings); video = **LiveKit self-hosted**; mapas = **OSM propio** (OSRM/Valhalla + Nominatim) vía **`@veo/maps`** (lib directa, con cache).

**Servicios nuevos vs blueprint:** `fleet-service` (vehículos/documentos/vencimientos/inspecciones) y `biometric-service`.
Onboarding conductor exige: **Licencia A1, SOAT, Tarjeta de propiedad, Antecedentes + Revisión Técnica (ITV)**.
Antecedentes y RENIEC = **revisión manual del operador ahora**, integración automática en F4.
Re-verificación biométrica periódica = gancho (ahora solo al inicio de turno).

**Comunicación interna:** **gRPC proto-first** (`protos/`) + mTLS en prod; Kafka para eventos async.

**API & operación:** prefijo **`/api/v1`** en BFFs; **rate limiting en BFFs** (Redis, por IP+usuario; **POST /panic jamás se limita**);
**CI por repo** (GitHub Actions: lint+typecheck+test+build); **seeds mínimos** (sin datos demo); **git aún NO inicializado** (a pedido).
