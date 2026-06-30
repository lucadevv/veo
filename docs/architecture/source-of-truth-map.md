# Mapa de fuentes de la verdad — admin panel (admin-bff)

> **Referencia de ingeniería.** Para CADA dato del panel admin: quién es el **DUEÑO**, cómo lo **LEE** el
> `admin-bff` (proyección o read-through al dueño en vivo), y si **RECONCILIA**. Es el checklist para no crear
> divergencias del tipo _"el panel dice X pero el backend dice Y"_.
>
> Última verificación: **2026-06-30**, contra el código (`archivo:línea`). Si tocás el flujo de datos de un
> dominio, actualizá su fila.

---

## TL;DR — el hallazgo que importa

**NO hay "muchas fuentes de la verdad".** Cada dato tiene **UN dueño** (un microservicio con su DB
autoritativa) — eso es separación de responsabilidades, correcto y deseado (regla del repo: cada servicio su
DB, no compartir tablas).

El `admin-bff` lee **read-through al dueño en vivo (REST firmado / gRPC) para CASI TODO.** Solo **DOS** datos se
**PROYECTAN** (cache CQRS en Redis): **viajes** y **conductores**. Y solo **UN** punto reconcilia la proyección
contra el dueño on-read (el badge de suspensión en la lista de conductores).

→ La sensación de "muchas fuentes" viene de esas **2 proyecciones cuando DIVERGEN** del dueño — no de los
dueños. **La cura NO es un gateway**: el `admin-bff` ya ES el gateway de lectura y ya hace read-through de todo
salvo 2 cosas. La cura son las **3 disciplinas** de abajo, aplicadas de forma consistente.

---

## Modelo mental (3 capas)

1. **DUEÑO** — el microservicio dueño de la DB autoritativa de ese dato. **UN dueño por dato.** No se comparte.
2. **PROYECCIÓN / read-model** — una **COPIA** del dato (cache eventualmente consistente, alimentada por eventos
   Kafka) para leer rápido sin pegarle al dueño en cada request. **NO es una segunda verdad: es un cache** que
   puede divergir (stale, o retiene lo que el dueño ya borró/purgó).
3. **LECTURA del BFF/UI** — cómo el `admin-bff` sirve el dato:
   - **read-through** — gRPC/REST en vivo al dueño → siempre autoritativo.
   - **proyección** — desde el read-model → rápido, puede estar stale.
   - **reconciliada** — proyección + corrección on-read contra el dueño, en el punto donde la divergencia importa.
   - **La UI solo REFLEJA** lo que el BFF le da (la UI nunca autoriza ni computa la verdad).

---

## Las 3 disciplinas (cómo NO crear divergencias)

1. **La UI/BFF REFLEJA al dueño, NUNCA re-deriva.** Un veredicto o cómputo de dominio (operabilidad,
   elegibilidad, suspensión, tarifa) lo calcula el **DUEÑO** y se propaga; el BFF/UI lo **muestra**, no lo
   recalcula. Recalcular downstream garantiza divergencia el día que la regla cambie en el dueño y no en la UI.
   - _Violación corregida:_ el detalle de flota inventaba "Listo para operar" desde la ficha en vez de reflejar
     el `operable` que fleet-service ya manda → commit `6beca6b`.

2. **Una proyección es un cache: o se mantiene en sync (consume TODOS los eventos del ciclo de vida, incluido
   borrado/purga) o el detalle hace read-through al dueño + degrada HONESTO cuando diverge.** Una proyección que
   no consume la baja del dato muestra registros que el dueño ya no tiene.
   - _Violación corregida:_ el detalle de viaje mostraba "error de servidor" para un viaje que trip-service
     purgó pero seguía en la proyección → ahora distingue 404 ("viaje no disponible") de 5xx → commit `bb49d58`.

3. **El contrato del dato se define UNA vez en el paquete compartido (`@veo/api-client` / `@veo/rpc`), no se
   re-declara** en cada servicio. Re-declarar el mismo tipo en N lados es el olor que alimenta la sensación de
   "¿dónde está la verdad de la forma?".
   - _Olor pendiente:_ `CostPerKmListView` declarado en 3 lados con la misma forma (DRY de contrato).

---

## El mapa

| Dato | Dueño | Cómo lo lee el admin-bff (`archivo:línea`) | ¿Reconcilia? | Riesgo |
|---|---|---|---|---|
| **Viajes — LISTA** | trip-service | **Proyección** Redis · `readModel.listTrips` — `ops/ops.service.ts:327` (alimentada por eventos `trip.*`, TTL 14d) | **No** | **MEDIO** — refleja solo lo que llegó por Kafka; evento perdido/reordenado → stale. Retiene viajes purgados del dueño (de ahí el 404 en el detalle) |
| **Viajes — DETALLE** | trip-service (+identity, +fleet) | **Read-through** gRPC `GetTrip` — `ops.service.ts:399` + fan-out a identity/fleet (`:404-415`) | Sí (lee al dueño) | BAJO — `eta/driverLocation/timeline` van `null`/`[]` honesto (no expuestos por GetTrip aún) |
| **Conductores — LISTA** | identity (perfil/suspensión) | **Proyección** Redis `readModel.listDrivers` — `ops.service.ts:341` **+ batch gRPC** `GetDriversByIds` — `:363` | **SÍ, on-read** — el batch reconcilia el **badge de suspensión** contra `suspendedAt` de identity (`:376`) + enriquece PII (Compliance+) | BAJO en suspensión (reconciliado); MEDIO en el resto del `status` (sale del read-model sin reconciliar; la autoridad es identity) |
| **Conductores — DETALLE** | identity + fleet | **Read-through** gRPC `GetDriver` + `GetDriverDocuments` + `GetDriverActiveVehicle` + `GetDriverInspectionStatus` — `ops.service.ts:467-618` | Sí (lee al dueño) | BAJO |
| **Operadores** | identity | **Read-through** REST `/admin/operators` — `ops.service.ts:1120` | Sí | BAJO |
| **Flota / vehículos** (lista+detalle) | fleet-service | **Read-through** REST `/vehicles`, `/vehicles/:id` — `fleet/fleet.service.ts:104,113` | Sí | BAJO — **`operable`/`operabilityReason` los deriva fleet-service** (el dueño, mismo veredicto que gatea el match); el BFF solo los pasa con degradación segura (`:327-331`). El flag `active` stored está **DEPRECADO** |
| **Documentos / inspecciones / vencimientos / modelos** | fleet-service | **Read-through** REST `/documents`, `/inspections`, `/fleet/expirations`, `/vehicle-models[/review]` — `fleet.service.ts:125-246` | Sí | BAJO |
| **Pánicos** | panic-service | **Read-through** REST `/panic`, `/panic/:id` — `security/security.service.ts:65,74` (detalle enriquece nombres vía trip+identity gRPC) | Sí | BAJO |
| **Video / media** | media-service | **Read-through** REST `/media/access[...]` — `media/media.service.ts:134-270` (live-token valida el viaje vía trip gRPC antes de mintear, `:248`) | Sí | BAJO |
| **Pricing** (modo, base-fare, fuel, energy, bid-floor) | **trip-service** | **Read-through** REST `/internal/pricing/*` — `pricing/pricing.service.ts:71-199` | Sí | BAJO — versionado CAS (`expectedVersion`) en el dueño; el BFF solo proxea |
| **Cost-per-km carpooling** | **booking-service** | **Read-through** REST `/internal/finance/cost-per-km` — `finance/finance.service.ts:215` (token `REST_BOOKING`) | Sí | BAJO — OJO: vive en **booking**, NO en payment |
| **Comisión** | **payment-service** | **Read-through** REST `/internal/finance/commission` — `finance.service.ts:181` | Sí | BAJO |
| **Catálogo de ofertas** | **trip-service** | **Read-through** REST `/internal/catalog` — `catalog/catalog.service.ts:39` | Sí | BAJO — tipos compartidos `ResolvedOffering`/`OfferingOverride` (anti-drift) |
| **Liquidaciones / payouts / refunds** | **payment-service** | **Read-through** REST `/payouts/all`, `/payments/:id/refund` — `finance.service.ts:106,245` (Idempotency-Key propagado al dueño) | Sí | BAJO — desglose (gross/comisión/neto/heldReason) es server-truth de payment, no se recalcula |
| **Auditoría** | audit-service | **Read-through** REST `/audit`, `/audit/verify` — `audit/audit.service.ts:42,60` | Sí | BAJO |
| **Métricas / analytics** | trip + dispatch + panic + payment (cada uno dueño de SU stat) | **Read-through en paralelo** a `/internal/analytics/*` — `analytics/analytics.service.ts:64-81`; agrega con degradación honesta (`safe()` → 0/null si un servicio cae) | N/A (agrega, no proyecta) | BAJO — **ClickHouse NO está cableado** (`clickhouse.service.ts` marcado DEUDA, sin uso): no hay OLAP histórico aún |

---

## Lo que es PROYECCIÓN (los 2 ÚNICOS read-models)

Todo lo de la tabla es read-through **salvo estas dos entidades**, proyectadas en Redis
(`read-model/read-model.service.ts`), alimentadas por `events/kafka-consumer.service.ts`:

### 1. Viajes — `bff:rm:trips` (+ índices por status/driver/passenger), TTL 14d
Eventos: `trip.requested` → REQUESTED · `trip.assigned|accepted|arriving|arrived|started|completed|cancelled`
→ patch de status. **No consume baja/purga** → un viaje purgado en trip-service queda en la lista hasta que
expira el TTL; el detalle (gRPC) 404ea → se degrada honesto ("Viaje no disponible").

### 2. Conductores — `bff:rm:drivers` (+ índice por status), SIN TTL (entidad admin durable)
Upsert con CAS atómico en Lua (fence anti-TOCTOU multi-réplica). Eventos: `driver.registered` → PENDING ·
`driver.verified` → ACTIVE · `driver.rejected` → REJECTED · `driver.resubmitted` → PENDING · `driver.flagged`
→ solo rating · `driver.suspended`/`driver.reactivated` (manual) → SUSPENDED/ACTIVE · `fleet.driver_suspended`
→ SUSPENDED **solo si trae `driverId`**.
> **El hueco conocido:** la suspensión por **ITV** llega keyeada por `userId` (no `driverId`) y la
> auto-reactivación no emite evento → el read-model NO los ve. Por eso `listDrivers` **reconcilia el badge de
> suspensión on-read** contra `suspendedAt` de identity (`ops.service.ts:376`). Es el único punto de
> reconciliación proyección↔dueño del BFF.

---

## Reglas operativas (derivadas del mapa)

Al agregar o tocar un dato del panel, en orden:

1. **Por default, read-through al dueño.** Proyectá SOLO si la lectura es caliente (lista paginada de alto
   volumen) Y tolerás eventual-consistencia. Hoy solo viajes y conductores lo justifican.
2. **Si proyectás:** consumí TODOS los eventos del ciclo de vida del dato — incluido **borrado/purga** — o
   reconciliá on-read contra el dueño en el punto donde la divergencia importa (como el badge de suspensión).
3. **Si mostrás un veredicto computado** (operabilidad, elegibilidad, tarifa derivada): que lo compute el
   **dueño** y propagalo; **nunca lo recalcules** en BFF/UI.
4. **Si el detalle (autoritativo) puede 404 mientras la lista (proyección) aún lo muestra:** degradá honesto
   (404 ≠ 500) — "no disponible / archivado", no "error de servidor · reintentar".
5. **El tipo del dato se define una vez** en `@veo/api-client` (REST) o `@veo/rpc` (gRPC) e se importa; no se
   re-declara por servicio.

---

## Casos vivos (sesión 2026-06-30)

| Disciplina | Caso | Estado |
|---|---|---|
| 1 — reflejar, no re-derivar | Detalle de flota mostraba "Listo para operar" re-derivado; ahora refleja `operable` del dueño | ✅ `6beca6b` |
| 2 — proyección diverge → degradar honesto | Detalle de viaje purgado: "error de servidor" → "Viaje no disponible" | ✅ `bb49d58` |
| 3 — contrato una vez | `CostPerKmListView` re-declarado en 3 lados | ⏳ pendiente |
| 2 — proyección en sync | El read-model de viajes no consume la purga (de fondo: que la proyección respete la baja) | ⏳ pendiente |
