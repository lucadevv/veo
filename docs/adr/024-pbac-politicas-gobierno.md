# ADR 024 — PBAC: capa de Políticas de gobierno sobre RBAC

> Estado: **ACEPTADO — F0 implementada; F1/F2 en curso** (el código aterrizó el 2026-07-10). Fecha: 2026-07-10.
> Define el backend de la sección **Gobierno → Políticas** del admin (diseñada en `design/veo.pen`,
> frames `AdminPoliticas`/`AdminPoliticas-Config`). El motor PBAC ya existe en código: paquete `@veo/policy`
> (`packages/policy/src/`), tabla `Policy` en identity-service (`prisma/schema.prisma:458` + migración
> `20260710073631_add_policies`), endpoints admin-bff `GET/PUT /gobierno/policies`
> (`services/bff/admin-bff/src/gobierno/gobierno.controller.ts`) y la página real en admin-web
> (`apps/admin-web/src/app/(dashboard)/gobierno/politicas/page.tsx`). Lo que resta es el enforcement net-new
> (F2) y completar el cableado cross-servicio de `auth.stepup` (§8). Este ADR fija cómo se llevó a código con
> honestidad. Complementa (no reemplaza) el RBAC base (`@veo/auth` `RolesGuard`, `packages/shared-types` `AdminRole`).
>
> 📌 **Estado real por fase (2026-07-10, verificado contra código): ver §8.**
>
> 🔎 **Fundado en grounding real del código (2026-07-10):** de las 16 políticas de la pantalla, **0 son
> editables hoy**, **7 están ENFORCED-HARDCODED** (const/env → una política solo las parametrizaría) y
> **8 son NET-NEW** (enforcement de cero). No hay storage central de config: cada dominio guarda el suyo
> (`DispatchRadiusConfig`, `BaseFareConfig`, …). El molde de "config admin-editable" a imitar es
> radius-config (ADR contexto §4).

---

## 0. Contexto y problema

El diferenciador de VEO es la **seguridad y el cumplimiento (Ley 29733)**. El RBAC base ya responde
*«¿este rol PUEDE hacer esto?»* (estático, `rol → permiso`). Lo que falta es la capa que responde
*«¿bajo QUÉ CONDICIONES aplica ese acceso?»* — MFA fresca, N-aprobadores distintos, ventana temporal,
IP de origen, enmascarado de PII, retención, borrado. Eso es **PBAC/ABAC**: control por **políticas**
contextuales.

Hoy esas condiciones existen a medias y **dispersas y hardcodeadas**: el step-up es `300s` const
(`packages/auth/src/guards/step-up-mfa.guard.ts:15`), la retención es `RETENTION_DEFAULT_DAYS` env
(default 30), el four-eyes de video es un check de identidad recién agregado, etc. **El superadmin no
puede ver ni ajustar ninguna** desde un solo lugar, y no hay auditoría de esos cambios de política.

**Problema:** llevar la pantalla de Políticas a código SIN un backend real produciría una grilla de
perillas que no gobiernan nada — peor que no tenerla, porque *insinúa* controles que no operan.

---

## 1. RBAC vs PBAC — coexisten, no compiten

| | RBAC (existe) | PBAC (este ADR) |
|---|---|---|
| Pregunta | ¿quién puede? | ¿bajo qué condiciones? |
| Naturaleza | estático `rol→permiso` | dinámico, contextual |
| Dónde | `@veo/auth` `RolesGuard` + `AdminRole` | registro de políticas + guards policy-aware |
| Ejemplo | `finance:payout` = solo FINANCE | "payout > S/5000 exige step-up fresco < N min" |

**Composición en la cadena de guards** (orden actual, `admin-bff app.module.ts`):
`JwtAuthGuard → SessionRevocationGuard → RateLimitGuard → RolesGuard → StepUpMfaGuard`.
El PBAC **no agrega un guard monolítico**: cada política vive en el guard/servicio que ya es su punto
natural de enforcement, pero **lee su parámetro del registro central** en vez de un const. RBAC decide
primero (¿puede el rol?); PBAC estrecha después (¿cumple la condición?). Una política NUNCA concede de
más ni afloja un candado legal — solo puede endurecer o parametrizar dentro de lo que el RBAC ya permite.

---

## 2. Decisión — registro central en identity-service + `@veo/policy` + Kafka

**Storage:** un módulo **`policies`** nuevo dentro de **`identity-service`** (que ya es dueño del
bounded-context de gobierno: admin users, roles, MFA). Tabla `Policy` versionada en su schema. Se evita
un 15º servicio; hay un seam limpio para extraer un `governance-service` si crece (ver §9).

**Distribución:** al mutar una política, identity-service **bumpea `version` + persiste + emite
`policy.updated` por outbox/Kafka en la misma tx** (patrón radius-config). 

**Consumo:** un paquete nuevo **`@veo/policy`** — cliente cacheado que cada guard/servicio usa para leer
el valor vigente de una política, con **`DEFAULT` fallback fail-safe** (si no hay fila o el cache está
frío, se usa el default seguro hardcodeado = el comportamiento de hoy). Suscribe `policy.updated` para
invalidar cache → el cambio del superadmin surte efecto **inmediato**, sin esperar TTL.

**Por qué central (y no per-dominio):** varias políticas son **cross-cutting** (la ventana de step-up la
usan trip/booking/payment/media) → no tienen dueño de dominio único. Un registro central + `@veo/policy`
las unifica y le da a la pantalla de admin **una sola fuente**. El enforcement sigue distribuido (media
enforcea retención; el guard enforcea step-up), pero el **parámetro** es central y auditado.

---

## 3. Modelo de datos (`Policy`)

```prisma
model Policy {
  key         String   @id                 // 'auth.stepup', 'media.dual-auth', ...
  family      String                        // 'auth' | 'data' | 'access' | 'ops'
  enabled     Boolean  @default(true)
  params      Json     @default("{}")       // typed por política (Zod en @veo/policy)
  mandatory   Boolean  @default(false)      // Ley 29733: no desactivable (candado)
  version     Int      @default(1)          // bump en cada cambio (cache-busting)
  updatedBy   String                        // actorId (auditoría)
  updatedAt   DateTime @updatedAt
  @@map("policies")
  @@schema("identity")
}
```

- `params` es `jsonb` con **schema tipado por política** en `@veo/policy` (Zod) — no un blob libre.
- `mandatory:true` (pii.mask, privacy.erasure) ⇒ el `enabled` no se puede poner en `false` (el candado
  del diseño). El registro lo valida y el audit lo refleja.
- El **motivo/valor de verdad de accountability sigue siendo el audit WORM** (cada cambio se audita, §6);
  la tabla `Policy` es el estado vigente para el runtime.

---

## 4. Enforcement — dos tipos

**(a) Config-políticas** (parametrizan enforcement que YA existe — las 7 hardcoded). Barato: se reemplaza
el `const`/`env` por `policy.get('<key>').<param>` (cacheado, DEFAULT = el valor de hoy). Ej.:

```ts
// packages/auth/src/guards/step-up-mfa.guard.ts (hoy: maxAgeSec = 300 const)
const maxAgeSec = await policy.number('auth.stepup', 'maxAgeSec', /* default */ 300);
```

**(b) Guard-políticas** (enforcement NET-NEW — las 8). Caro: cada una es un mini-feature (un guard o un
mecanismo nuevo) que además lee su config del registro. Ej. `access.ip-allowlist` ⇒ nuevo
`IpAllowlistGuard` global en admin-bff que lee la allowlist de la política.

**Regla de oro:** el `DEFAULT` de toda config-política = el comportamiento seguro de HOY. Si el registro
o Kafka fallan, el sistema **no se abre**: cae al default endurecido. Fail-safe, nunca fail-open.

---

## 5. Catálogo de las 16 políticas (estado real + punto de enforcement)

| # | key | Familia | Clase | Enforcement point | Param (default real) | Mandatory |
|---|---|---|---|---|---|---|
| 1 | `media.dual-auth` | data | HARDCODED | `media-service access.service.ts:143` (four-eyes por identidad+rol) | `approvers:N` (hoy N=2 implícito) | — |
| 2 | `pii.mask` | data | HARDCODED | `admin-bff redaction.policy.ts:54` + `identity document.ts` | sets de roles (const) · `dniTail:4` | **sí** |
| 3 | `pii.reveal-stepup` | data | **NET-NEW** | admin-bff detalle conductor (hoy solo RBAC) | `maxAgeSec` (no existe) | — |
| 4 | `media.retention` | data | HARDCODED | `media-service retention.sweeper.ts` | env `RETENTION_DEFAULT_DAYS=30` (⚠️ .pen dice 90) | parcial |
| 5 | `privacy.erasure` | data | HARDCODED | `identity deletion.sweeper.ts:35` | env `DELETION_GRACE_DAYS=30` | **sí** |
| 6 | `auth.mfa` | auth | HARDCODED | `identity admin.service.ts:281` (login) | always-on (sin knob) | **sí** |
| 7 | `auth.stepup` | auth | HARDCODED | `@veo/auth step-up-mfa.guard.ts:15` | `maxAgeSec=300` const | — |
| 8 | `auth.session-timeout` | auth | **NET-NEW** | — (solo TTL duro 15m, sin idle) | `idleMin` (no existe) | — |
| 9 | `auth.daily-reauth` | auth | **NET-NEW** | — | (no existe) | — |
| 10 | `access.jit` | access | **NET-NEW** | — (no hay grants con expiración) | `ttlHours` (no existe) | — |
| 11 | `access.ip-allowlist` | access | **NET-NEW** | nuevo `IpAllowlistGuard` admin-bff | `cidrs[]` (no existe) | — |
| 12 | `access.review` | access | **NET-NEW** | — (sin recertificación) | `periodDays` (no existe) | — |
| 13 | `access.least-privilege` | access | HARDCODED | RBAC + redacción default-null | matriz `AdminRole` const | — |
| 14 | `ops.export` | ops | **NET-NEW** | — (no hay endpoints de export) | roles/config (no existe) | — |
| 15 | `ops.third-party-share` | ops | (producto) | `share-service` (feature, no política) | — | — |
| 16 | `ops.bulk-download` | ops | **NET-NEW** | — | (no existe) | — |

> Fuente de cada `file:line` en el grounding de esta sesión. **7 HARDCODED · 8 NET-NEW · 1 es feature de
> producto (no política).**

---

## 6. Flujo admin CRUD + auditoría (molde radius-config)

1. Superadmin edita en **Gobierno → Políticas** (el `.pen`) → `PUT /api/bff/gobierno/policies/:key`
   con `{ enabled?, params? }`.
2. **admin-bff** (borde de autoridad): `@Roles(SUPERADMIN)` + `@RequireStepUpMfa()` + audiencia admin-rail.
   Rechaza desactivar una `mandatory`. Reenvía a identity-service por REST interno firmado (HMAC).
3. **identity-service** `policies` module: valida `params` contra el schema Zod de la key, bumpea
   `version`, persiste + `enqueueOutbox('policy.updated', {key, version})` **en la misma tx** +
   registra en el **audit WORM** (`audit.record` con `action:'policy.update'`, before/after).
4. **Kafka** `policy.updated` → cada servicio con `@veo/policy` invalida su cache de esa key.
5. La pantalla refleja "N cambios sin guardar" → "Guardar" hace el PUT; cada save queda auditado.

Es exactamente la anatomía ya probada de `radius-config` (tabla versionada → PUT admin-gated →
bump+outbox+cache-invalidation → hot-path con DEFAULT fallback).

---

## 7. Reconciliación .pen ↔ código (honestidad obligatoria)

El diseño promete valores que el código NO tiene. Antes de implementar, **el `.pen` y el backend deben
acordar**:

- **`media.retention`:** la pantalla dice **90 días**; el código usa **30** (`RETENTION_DEFAULT_DAYS`).
  Y **NO hay WORM/object-lock S3 real** — hoy es una columna `retentionUntil` + sweeper que BORRA. El
  "WORM inmutable con object-lock" que promete la UI (y la Ley 29733) es una **tarea de INFRA aparte**
  (config del bucket MinIO con object-lock + retención), **no una política**. Este ADR NO la cubre; se
  marca como dependencia.
- **`pii.reveal-stepup` (< 10 min):** **no existe**. Revelar el DNI hoy es solo RBAC (Compliance+ vía
  audiencia admin-rail). Es NET-NEW: agregar `@RequireStepUpMfa` con ventana propia al reveal.
- **`auth.stepup` (< 5 min):** coincide (300s). ✅
- **`media.dual-auth` (2 aprobadores):** el four-eyes por identidad+rol ya existe (fixes de hoy). El
  "N configurable" es la parametrización; hoy N=2 implícito.

**Decidir por cada mismatch:** ¿ajustamos el default del código al valor del diseño (retención→90d) o
ajustamos el diseño al código? (recomendado: alinear en la implementación de Fase 1, con el default real
visible en la UI).

---

## 8. Plan por fases

- ✅ **Fase 0 — Fundación. IMPLEMENTADA (2026-07-10).** `@veo/policy` con cliente cacheado + schemas/catálogo
  + DEFAULTs (`packages/policy/src/catalog.ts`, `permissions.ts`) y runtime `@veo/policy/nest`
  (`KafkaCachedPolicyReader` + `PolicyModule`, `packages/policy/src/nest/`) · módulo `policies` en
  identity-service (tabla `Policy` `schema.prisma:458` + migración, repository/service/controller/seeder en
  `services/identity-service/src/policies/`, outbox `policy.updated`, audit) · endpoints admin-bff
  `GET/PUT /gobierno/policies` (`services/bff/admin-bff/src/gobierno/gobierno.controller.ts`) con
  RBAC(SUPERADMIN)+step-up (guards en `services/bff/admin-bff/src/policies/`) · la **página Políticas real**
  en admin-web (`gobierno/politicas/page.tsx` + `components/gobierno/policies-panel.tsx`).
- 🟡 **Fase 1 — Parametrizar los HARDCODED. EN CURSO.** `auth.stepup` ya lee del registro vía
  `PolicyReaderPort` en el step-up guard (`packages/auth/src/guards/step-up-mfa.guard.ts:47` —
  `numberSync('auth.stepup','maxAgeSec',300)`) y `PolicyModule` está cableado en admin-bff
  (`app.module.ts:52`). ⏳ **Pendiente:** cablear `PolicyModule`/`auth.stepup` en **payment / trip / booking**
  (hoy no lo importan) y parametrizar el resto de los const/env (retención, erasure SLA, N-aprobadores,
  sets de `pii.mask`).
- 🟡 **Fase 2 — NET-NEW. PARCIAL.** ✅ Ya implementadas: `access.ip-allowlist` (`IpAllowlistGuard`) y
  `auth.session-timeout` (`SessionIdleGuard`) en `services/bff/admin-bff/src/policies/`, más el step-up
  policy-aware de `pii.reveal-stepup` (`PolicyStepUpMfaGuard`). ⏳ **Pendiente** (net-new que dependen de una
  feature de export aún inexistente): `access.jit`, `auth.daily-reauth`, `access.review`,
  `ops.export`/`ops.bulk-download` — sus keys están sembradas en el catálogo con default cerrado, sin
  enforcement todavía.
- ⏳ **Dependencia de INFRA (no PBAC):** WORM object-lock de video (MinIO) — tarea separada, **pendiente**.

---

## 9. Consecuencias, no-goals y riesgos

- **No-goal:** el **overlay de visibilidad de features** (superadmin oculta features por rol, pantalla
  "Permisos y visibilidad") es un producto **distinto** (RBAC subtract-only, no PBAC condicional). Se
  diseña/implementa aparte; comparte el bounded-context de gobierno (podría vivir en el mismo módulo
  `policies` o su hermano).
- **Riesgo — fail-open:** mitigado por el DEFAULT fail-safe de `@veo/policy` (si el registro/Kafka caen,
  se usa el valor endurecido de hoy). Ninguna política puede *conceder* — solo endurecer/parametrizar.
- **Riesgo — deriva UI↔backend** (como el step-up drift que el audit encontró): el schema Zod por política
  es la fuente única de forma; la UI de config debe consumir ese schema.
- **Desacople de `@veo/policy` en `packages/auth`:** los guards de bajo nivel (`StepUpMfaGuard`) NO deben
  depender directo del cliente runtime de `@veo/policy` (cache + suscripción Kafka) — sería un paquete leaf
  cargando peso de infra y con riesgo de ciclo. `packages/auth` define un **token/interfaz `PolicyReader`**
  (solo lectura: `number(key,param,default)`, `bool(...)`, `list(...)`); `@veo/policy` provee la impl
  concreta; cada servicio la **inyecta por DI**. Si un servicio no la registra, el guard usa el `default`
  in-situ (mismo fail-safe). Así `packages/auth` sigue desacoplado y testeable.
- **Extracción futura:** si `policies` crece (overlay + más familias), se extrae a `governance-service`
  con su DB — el seam (módulo aislado + eventos) ya lo permite.

---

## Referencias
- Diseño: `design/veo.pen` frames `AdminPoliticas`, `AdminPoliticas-Config`, componente `C/AdminSidebar`.
- Molde de config admin-editable: `services/dispatch-service` `DispatchRadiusConfig` (tabla+PUT+outbox+cache).
- RBAC base: `packages/auth` `RolesGuard`/`StepUpMfaGuard`, `packages/shared-types` `AdminRole`.
- Audit WORM: `services/audit-service` + ADR de auditoría. Matriz permisos×roles: `docs/ESTADO-AUTH-CONDUCTOR-Y-ADMIN.md`.
- Grounding del estado real de las 16 políticas: sesión de audit 2026-07-10 (memoria `admin/audit-seams-rbac-2026-07`).
