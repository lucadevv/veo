# ADR 025 — Modelo de Gobierno unificado (Roles · Permisos · Overlay · Políticas)

> Estado: **ACEPTADO — F0 implementada; F1 (enforcement server) en curso, F2 (front) parcial** (el código
> aterrizó el 2026-07-10). Fecha: 2026-07-10.
> Nació de una incoherencia REAL detectada: las **Políticas** (PBAC) eran un registro editable y real
> (ADR-024), pero los **Permisos** en código quedaron como una matriz **read-only** y el **overlay
> interactivo** del diseño (`design/veo.pen` frame `AdminPermisos`) **no existía**. Ya se cerró esa brecha:
> el overlay es un registro real — modelo `PermissionOverride` (`identity-service/prisma/schema.prisma:487`
> + migración `20260710130417_add_permission_overrides`), endpoints admin-bff
> `GET/PUT /gobierno/permission-overrides`, evento `permission_override.updated`, y la matriz interactiva en
> admin-web (`apps/admin-web/src/components/gobierno/permissions-matrix.tsx`). Lo que resta es el barrido
> endpoint→`@Permission` para que el enforcement server-side deje de ser NO-OP (F1, §7).
> Este ADR NO reemplaza a [ADR-024](./024-pbac-politicas-gobierno.md) — lo **enmarca**: las políticas son
> UNA de las dos capas editables de un mismo gobierno. Establece el modelo por capas y llevó a código la
> pieza que faltaba (el overlay), unificándola con las políticas en **un solo módulo**.
>
> 📌 **Estado real por fase (2026-07-10, verificado contra código): ver §7.**

---

## 0. Contexto — no son 3 cosas, son 4 CAPAS de una

"Roles", "Permisos" y "Políticas" no son features separados: son **capas del gobierno del acceso**, de la
más estable a la más dinámica.

| # | Capa | Responde | Vive HOY | ¿Editable en runtime? |
|---|------|----------|----------|------------------------|
| 0 | **Roles** | quién sos (SUP, ADM, FIN, CMP, DSP, L2, L1) | enum `@veo/shared-types` `AdminRole` | **NO** (código) |
| 1 | **Permisos base** | qué puede cada rol | `@Roles` en controllers + `apps/admin-web/src/lib/rbac.ts` `PERMISSION_ROLES` | **NO** (código) |
| 2 | **Overlay** | el superadmin *RESTA* permisos a un rol | **no existe** (diseñado en .pen) | **SÍ** (registro) |
| 3 | **Políticas (PBAC)** | bajo qué *condiciones* aplica el acceso | registro `Policy` en identity (ADR-024) | **SÍ** (registro) |

---

## 1. El boundary de seguridad — qué es código y qué es editable (y por qué)

**Decisión dura: las capas 0 y 1 (Roles + Permisos base) viven en CÓDIGO, y así se quedan.**
No es incoherencia — es un candado deliberado:
- Un cambio de "qué rol tiene qué permiso" tiene impacto de seguridad (ej. no querés que alguien conceda
  `finance:payout` a un `SUPPORT_L1` desde una UI). Debe pasar por **PR + review**, no por runtime.
- Los `@Roles` son la **autoridad**; los servicios los re-validan (defensa en profundidad, ver audit
  2026-07-10).

**Invariante maestro:** las capas editables (2 y 3) **solo pueden RESTAR o CONDICIONAR — NUNCA conceden
de más ni aflojan un candado legal**. El overlay solo puede *quitar* un permiso que el rol YA tiene en la
base; una política solo puede *endurecer* (exigir MFA fresca, IP, etc.). Ninguna capa editable puede
darle a un rol algo que la base no le dio. Esto se enforcea, no se confía (§3, §6).

---

## 2. La unificación — un solo módulo de Gobierno

**La incoherencia real:** las DOS capas editables (Overlay + Políticas) hoy divergen — Políticas es un
registro real, el Overlay ni existe. Construir el Overlay como un **silo aparte** sería *otra*
incoherencia (dos registros de gobierno distintos, dos audits, dos clientes).

**Decisión:** el Overlay y las Políticas son **el mismo tipo de cosa** (overrides de gobierno editables,
subtract-only/condicionales, gobernados por el superadmin, auditados) y viven en **UN solo módulo**:
- El módulo `policies` de identity-service (ADR-024) **evoluciona a un módulo `gobierno`** que es dueño de
  **ambos** registros: `Policy` (condiciones) + `PermissionOverride` (overlay).
- **Mismo patrón para los dos**: tabla versionada → PUT admin-gated (SUPERADMIN + step-up) → bump version
  + outbox + **audit WORM** → distribución por Kafka → consumo vía **`@veo/policy`** (cache + DEFAULT
  fail-safe). Es EXACTAMENTE la mecánica ya validada en ADR-024, extendida a un segundo registro.
- La sección **"Gobierno"** del nav (Permisos y visibilidad + Políticas) ya agrupa esto en la UI; el
  backend ahora lo refleja: un bounded-context, un módulo, un audit.

---

## 3. El Overlay de visibilidad (la pieza nueva)

**Modelo de datos** (en el módulo gobierno de identity):
```prisma
model PermissionOverride {
  role       String   // AdminRole
  permission String   // 'drivers:approve', 'ops:view', ...
  hidden     Boolean  @default(true)   // subtract-only: true = RESTADO a ese rol
  updatedBy  String
  updatedAt  DateTime @updatedAt
  version    Int      @default(1)
  @@id([role, permission])
  @@map("permission_overrides")
  @@schema("identity")
}
```
- **Semántica subtract-only:** el permiso EFECTIVO de un rol = `base(rol, permiso)` **AND NOT**
  `override.hidden`. El registro solo guarda los pares *restados*; ausencia de fila = comportamiento base.
- **Invariante enforceado:** al escribir un override, el backend RECHAZA cualquier intento sobre un par
  `(rol, permiso)` que la base NO concede (no se puede "restar" algo que no existe → señal de que se
  intentó usar el overlay para conceder). El overlay nunca amplía.
- **Los candados legales no se pueden restar:** un permiso marcado como legal-mandatory (ej. `audit:*`
  para COMPLIANCE, separación de funciones Ley 29733) NO es override-able-off — el registro lo rechaza,
  igual que una política `mandatory`.

**Enforcement server-side** (el punto clave — "bloquear, no solo ocultar"):
- Hoy los endpoints declaran `@Roles(...)`. Para que el overlay bloquee por PERMISO, cada endpoint debe
  mapear a su **permiso** (ej. un `@Permission('drivers:approve')` explícito, o un mapa central
  endpoint→permiso derivado de `PERMISSION_ROLES`). El `RolesGuard` (o un `PermissionGuard` hermano)
  computa: `base ∧ ¬override` consultando el overlay vía `@veo/policy` (cache Kafka-invalidada). Si el
  par está restado para el rol del actor → `ForbiddenError`, aunque el `@Roles` base lo permitiera.
- **Front oculta**: `can(user, permiso)` en `rbac.ts` compone base ∧ ¬override (el front lee el overlay
  vigente) → el nav/botón desaparece. Pero la **autoridad es el server** (defensa en profundidad).
- **Fail-safe:** si el overlay no carga (cache frío/identity caído) → se usa la BASE sola (no se resta
  nada). Nunca fail-open a conceder; nunca fail-closed a bloquear todo por un fallo de lectura.

---

## 4. Relación con ADR-024 (Políticas)

ADR-024 sigue vigente y CORRECTO — describe la capa 3 (Políticas/PBAC) en detalle. Este ADR:
- Lo **enmarca** como una de las dos capas editables.
- Extiende el módulo (`policies` → `gobierno`) para que también posea el overlay (capa 2).
- Reusa TODO lo de F0/F1 del PBAC: el registro versionado, el evento Kafka, `@veo/policy`, el audit, los
  endpoints admin-bff SUPERADMIN+step-up. El overlay es "otra tabla + otro par de endpoints" en el MISMO
  módulo, no una infra nueva.

---

## 5. UI — la sección Gobierno queda coherente

- **Permisos y visibilidad**: la matriz pasa de **read-only** (lo que hay hoy) a **interactiva** fiel al
  `.pen` (`AdminPermisos`): toggle por celda `(rol × permiso)` que RESTA (subtract-only), con leyenda
  "base / restado por vos / candado legal no-restable / no aplica" + barra **Guardar cambios**. Cada save
  audita. La base (lo que el código concede) se muestra como el estado por defecto; el superadmin solo
  puede apagar celdas encendidas, nunca encender las apagadas por la base.
- **Políticas**: como está (ADR-024 Fase 0, ya en código).
- Las dos comparten el grupo GOBIERNO (solo superadmin) y el mismo lenguaje visual.

---

## 6. Consecuencias, no-goals, riesgos

- **No-goal:** editar Roles o la matriz base desde la UI. Sigue siendo código (PR + review). El overlay
  solo RESTA sobre la base.
- **Riesgo — el overlay se usa para "conceder":** imposible por diseño (subtract-only + rechazo de
  override sobre par no-base + el `@Roles` base sigue siendo el gate primario; el overlay solo agrega una
  negación).
- **Riesgo — endpoints sin mapeo a permiso:** el overlay solo bloquea donde el endpoint declara/deriva su
  permiso. Hay que mapear los endpoints admin a su permiso (un barrido, alineado con `PERMISSION_ROLES`).
  Mientras no estén mapeados, el overlay oculta en el front pero no bloquea en server para ese endpoint —
  se documenta el gap (honestidad), no se finge cobertura total de arranque.
- **Coherencia lograda:** Roles → Permisos base (código, autoridad) → Overlay → Políticas (registro
  editable, subtract/condition-only) — **un modelo por capas, un módulo de gobierno, un audit, un cliente
  de enforcement.**

---

## 7. Plan por fases

- ✅ **F0 — Overlay backend + UI. IMPLEMENTADA (2026-07-10)** (reusa el molde PBAC): tabla
  `PermissionOverride` (`schema.prisma:487`) + migración `20260710130417_add_permission_overrides` en el
  módulo gobierno · endpoints admin-bff `GET/PUT /gobierno/permission-overrides` (SUPERADMIN + step-up,
  `gobierno.controller.ts` + `permission-overrides.{repository,service,controller}.ts` en identity) · evento
  `permission_override.updated` + audit + consumer (`packages/policy/src/nest/permission-override-updated.consumer.ts`)
  · lectura en `@veo/policy` (overlay cache · `overlay.ts`, `permissions.ts` con `baseGrants` /
  `isPermissionEffective` / `computeHiddenPermissions`) · matriz interactiva en admin-web
  (`components/gobierno/permissions-matrix.tsx`, reemplaza el read-only).
- 🟡 **F1 — Enforcement server. EN CURSO.** El `PermissionOverlayGuard` ya está en la cadena de guards
  (`services/bff/admin-bff/src/app.module.ts:109`, tras `RolesGuard`) y computa `base ∧ ¬override`, y existe
  el decorador `@Permission` (`policies/permission.decorator.ts`) declarado en la mayoría de los controllers
  (11/12). ⏳ **Pendiente — el barrido no está completo:** el guard es **NO-OP por handler donde falta
  `@Permission`** (comentario explícito en `app.module.ts:105-108`; ej. `auth.controller.ts` aún sin
  `@Permission`). Hasta cerrar el barrido, el overlay oculta en el front pero **no bloquea en server** para
  esos endpoints — gap honesto, no se finge cobertura total.
- 🟡 **F2 — Front compose. PARCIAL.** El helper `computeHiddenPermissions` (`@veo/policy`) y la matriz
  interactiva ya componen `base ∧ ¬override`. ⏳ **Pendiente:** completar el ocultamiento de nav/botones
  atado al mismo barrido endpoint→permiso de F1.

---

## Referencias
- [ADR-024](./024-pbac-politicas-gobierno.md) — Políticas (PBAC), la capa 3.
- RBAC base: `packages/auth` `RolesGuard`, `packages/shared-types` `AdminRole`, `apps/admin-web/src/lib/rbac.ts` `PERMISSION_ROLES`.
- Registro de gobierno: `services/identity-service/src/policies/` (evoluciona a `gobierno`), `@veo/policy`.
- Diseño: `design/veo.pen` frame `AdminPermisos` (matriz interactiva). Audit de segregación (Ley 29733): memoria `admin/audit-seams-rbac-2026-07`.
