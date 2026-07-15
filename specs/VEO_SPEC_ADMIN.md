# VEO — Especificaciones de Diseño · DASHBOARD ADMIN

> **Producto:** Dashboard de operación, seguridad y compliance de VEO (plataforma de movilidad segura · Lima, Perú).
> **Plataforma:** Web · Next.js 14 (App Router) · React Query · Socket.IO (`/ops`).
> **Destinatario:** diseñador visual. Este documento define el **CÓMO visual** sobre el QUÉ/PORQUÉ del `VEO_BRIEF_DISENO.md`.
> **Fuente de verdad de color/tokens:** brief §3.3 (tema web OKLCH, **azul de marca `#2D7FF9`**, light + dark). **No se repiten hex acá** — se referencian por token semántico (`--bg`, `--surface`, `--ink`, `--brand`, `--accent`, `--success`, `--warn`, `--danger`, `--focus`).

---

## 0. Tono y principios rectores

Esto **no es marketing**. Es una **herramienta de operación crítica** donde un operador atiende un pánico real mientras decide payouts y revisa documentos vencidos. El diseño obedece a:

1. **Sobrio y data-first.** La pantalla existe para mostrar datos densos y permitir actuar rápido. Cero decoración. El acento azul de marca (`--accent`) ≤10% de la UI, reservado para acción primaria, enlaces y foco. La marca (`--brand`, el mismo azul) es marca/estructura, no relleno; en admin se distingue del acento por **peso y contexto**, no por otro color.
2. **Densidad legible.** Tablas compactas pero respirables, números tabulares, jerarquía por tipografía y espaciado — **nunca** por color decorativo (ver KPIs).
3. **Accesibilidad AA reforzada — regla no negociable.** Ningún estado crítico se comunica **solo por color**. Todo estado de riesgo lleva **icono + texto + color** simultáneamente. Los pánicos SIEMPRE: `--danger` + icono `ShieldAlert` + copy explícito.
4. **Tiempo real visible pero no ansioso.** El "En vivo" pulsa sutil; los pánicos irrumpen; el resto es estable.
5. **Seguridad por diseño.** Acciones sensibles (ver video, payout) exigen step-up MFA. Todo queda auditado. Datos sensibles se truncan (IDs a 8 chars, nombres solo cuando el servidor los entrega).
6. **Español operativo peruano.** Claro, imperativo, sin jerga técnica de cara al usuario: "Reconocer", "Atender", "Ejecutar pago", "Verificar cadena".

---

## 1. Sistema base (transversal a todas las pantallas)

### 1.1 Tipografía

| Uso                               | Familia                                | Notas                                                                                                                 |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| UI general, texto                 | **Inter** (`--font-sans`, self-hosted) | Pesos: 400 cuerpo, 500 labels/medium, 600 títulos. Soberanía: fuente auto-hospedada, sin request a Google en runtime. |
| IDs, montos, código, TOTP, hashes | **JetBrains Mono** (`--font-mono`)     | Todo dato técnico/numérico va monospace para alinear columnas.                                                        |
| Cifras en tablas y KPIs           | clase `tabular` (tabular-nums)         | Números alineados verticalmente; obligatorio en montos, contadores, fechas.                                           |

**Escala de texto operativa (densa):** títulos de página 2xl/semibold; títulos de sección `text-sm` semibold; labels de campo/columna `text-xs` `text-ink-muted`; metadata `text-[11px]`/`text-xs` `text-ink-subtle`. Jerarquía de 3 niveles de tinta: `--ink` (primario) → `ink-muted` (secundario) → `ink-subtle` (terciario/placeholder).

### 1.2 Tablas densas (componente `DataTable`)

El caballo de batalla del dashboard. Reglas:

- Filas compactas (`px-4 py-2.5`), divisor sutil `border-border/60`, hover `bg-surface-2` solo si la fila es navegable (`cursor-pointer`).
- **Header sticky** (`bg-surface-2`) para scroll largo. Ordenamiento por columna con **`aria-sort`** e iconos `ArrowUp`/`ArrowDown`/`ChevronsUpDown` (nunca solo color).
- `<caption class="sr-only">` obligatorio por tabla (lectores de pantalla).
- Celdas de ID: mono, truncadas a 8 chars. Montos: `tabular` + `text-ink` medium. Estados: siempre vía `StatusPill` (texto + tono).
- Columna `Acciones` no ordenable, alineada, con botones contextuales por permiso.
- Scroll horizontal degrada limpio (`overflow-x-auto`).

### 1.3 Badges y estados de dominio (`StatusPill`)

Mapeo semántico **texto + color** (jamás color solo). El pill traduce el enum a español y asigna tono:
| Tono | Token | Estados incluidos |
|---|---|---|
| success | `--success` | APROBADO, ACTIVO, COMPLETADO, VERIFICADO, PAGADO, VIGENTE, RESUELTO |
| warn | `--warn` | PENDIENTE, EN REVISIÓN, PROGRAMADA, PROCESANDO, POR VENCER, RECONOCIDO |
| danger | `--danger` | RECHAZADO, BLOQUEADO, VENCIDO, FALLIDO, SUSPENDIDO, **ABIERTO** (pánico), **DISPARADO** |
| neutral | tinta neutra | sin clasificar |

El pill **siempre muestra la etiqueta en español**; el color es refuerzo, no el único canal.

### 1.4 Grilla y layout

- **Shell de altura fija** (`h-screen`, overflow controlado): sidebar fija + columna de contenido con su propio scroll. Las pantallas usan `flex h-full flex-col` con header fijo y cuerpo scrolleable.
- Padding de contenido `px-4 lg:px-6`. Breakpoint operativo principal `lg`.
- Vistas de operación con **split** (`lg:grid-cols-[1fr_400px]`): mapa flexible + panel lateral de ancho fijo.

### 1.5 Gráficas (recharts)

- Estilo sobrio: **líneas/áreas finas**, sin gradientes chillones, sin sombras. Acento azul de marca para la serie principal, neutros para ejes/grilla.
- Colores tomados de **tokens del tema en runtime** (hook `use-token-colors`) para respetar light/dark automáticamente.
- Tooltip con números tabulares, fecha legible. Eje Y formateado (montos en PEN, conteos abreviados).
- Toda gráfica acompaña a su KPI/sección, nunca decora sola.

### 1.6 Estados genéricos (componentes `EmptyState` / `ErrorState` / `Skeleton`)

| Estado                 | Patrón visual                                                                                                          | Copy                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Loading**            | `Skeleton` con la silueta real (filas de tabla, mosaico de KPIs, cards de mapa). Nunca spinner pelado.                 | —                                                               |
| **Vacío**              | Icono neutro en chip `surface-2` + título + descripción centrados.                                                     | "Sin viajes activos", "No hay alertas en esta vista."           |
| **Sin permiso (RBAC)** | `EmptyState` con icono **candado** (`Lock`), título "Acceso restringido".                                              | "Necesitas el rol FINANCE para ver liquidaciones y reembolsos." |
| **Error**              | `role="alert"`, icono `AlertTriangle` en chip `danger/10`, botón **Reintentar** (`RefreshCw`).                         | "No se pudieron cargar los datos. Intenta de nuevo."            |
| **Datos en vivo**      | Badge `ConnectionStatus` (punto + texto): "En vivo" (success, pulsa), "Reconectando…" (warn), "Sin conexión" (danger). | —                                                               |

### 1.7 Copy operativo

Imperativo, breve, sin ambigüedad. Botones = verbo ("Reconocer", "Resolver", "Ejecutar pago", "Verificar cadena"). Confirmaciones explican consecuencia y auditoría ("Esta acción queda auditada"). Errores accionables, no técnicos.

### 1.8 Motion

Discreto y funcional: transiciones de color 150ms en hover/nav; `active:scale-[0.97]` en botones de acción crítica; pulso lento (`animate-pulse-danger`) **solo** en el chip de pánico y el punto "En vivo". Nada más se mueve.

---

## 2. RBAC — 7 roles y adaptación del diseño

**Auth:** email corporativo + contraseña + **TOTP**. **Step-up MFA** (re-verificación TOTP fresca) para acciones sensibles: aprobar/reproducir video, y ejecutar payout. El estado `MFA fresco` se muestra como badge en el topbar.

**Principio de RBAC en UI:** la autoridad real es el `admin-bff` (revalida con guards). La UI es **defensa en profundidad de experiencia**: si el servidor lo negaría, la UI **lo oculta o deshabilita** (`can(user, permission)`). El mapa de permisos espeja exactamente los `@Roles` de cada controller.

### 2.1 Matriz de visibilidad por rol

| Permiso                                     | SUPPORT_L1 | SUPPORT_L2 | COMPLIANCE_SUP. | DISPATCHER |       FINANCE        | ADMIN | SUPERADMIN |
| ------------------------------------------- | :--------: | :--------: | :-------------: | :--------: | :------------------: | :---: | :--------: |
| Ops "En vivo" (`ops:view`)                  |     —      |     ✓      |        ✓        |     ✓      |          ✓           |   ✓   |     ✓      |
| Viajes / Conductores (`trips/drivers:view`) |     ✓      |     ✓      |        ✓        |     ✓      |          —           |   ✓   |     ✓      |
| Aprobar conductor (`drivers:approve`)       |     —      |     —      |        ✓        |     —      |          —           |   ✓   |     ✓      |
| Ver pánicos (`panics:view/ack`)             |     —      |     ✓      |        ✓        |     ✓      |          —           |   ✓   |     ✓      |
| Resolver pánico (`panics:resolve`)          |     —      |     —      |        ✓        |     —      |          —           |   ✓   |     ✓      |
| Flota (`fleet:view/review`)                 |     —      |     —      |        ✓        |     —      |          —           |   ✓   |     ✓      |
| Finanzas ver/refund (`finance:view/refund`) |     —      |     —      |        —        |     —      |          ✓           |   ✓   |     ✓      |
| **Ejecutar payout (`finance:payout`)**      |     —      |     —      |        —        |     —      | **✓ (solo FINANCE)** |   —   |     —      |
| Video (`media:view/request/approve`)        |     —      |     —      |        ✓        |     —      |          —           |   ✓   |     ✓      |
| Auditoría (`audit:view/verify`)             |     —      |     —      |        ✓        |     —      |          —           | **—** |     ✓      |

> **Gotcha de diseño crítico:** `finance:payout` (ejecutar liquidación) es **exclusivo de FINANCE** — ni ADMIN ni SUPERADMIN lo ven. El servidor los negaría, así que la columna de acción **no se renderiza** para ellos (queda `—`). El diseñador no debe asumir que SUPERADMIN "puede todo".

> **Gotcha de audit (separación de funciones · decisión del dueño):** LEER/VERIFICAR el audit log es **exclusivo de `COMPLIANCE_SUPERVISOR` + `SUPERADMIN`** — un `ADMIN` genérico **NO**. Quien OPERA no audita: el audit log inmutable es la pista forense (Ley 29733), y el que ejecuta las acciones del día a día no debe ser el mismo que revisa el registro de quién hizo qué.

> **Principio de TRAZABILIDAD TOTAL (qué se ESCRIBE en el libro):** distinto de quién lo lee. **TODA mutación del sistema se audita** — _quién · qué · cuándo_, encadenada e inmutable. No es "auditar solo lo sensible": es auditar **todo todo**. Para cualquier acción, el audit log responde "¿quién hizo este cambio?". La fila de arriba define **quién puede leer** el libro; este principio define **qué se registra** (absolutamente todo).
>
> El gate ejecutable de este principio es el test golden-rule `audit.consumer.coverage.spec.ts` (todo evento de `EVENT_SCHEMAS` está auditado o excluido con razón). **DEUDA CERRADA** (antes: `driver.went_offline` fuera del WORM): el ciclo de **sesión de turno** del conductor ya se audita completo. Se agregó el par de apertura `driver.went_online` (identity emite en `startShift`, por outbox en la tx del CAS→AVAILABLE) y el cierre `driver.went_offline` se audita por `auditedWhen` **solo en la rama `shift_end`** (fin de turno deliberado); la rama `disconnect` (caída de socket best-effort) se descarta como no-op explícito — no es una mutación de negocio. Ambos con `actor=recurso=driverId, resource=driver`. Ya no hay divergencia contra "todo todo".

### 2.2 Cómo se adapta el diseño

- **Sidebar:** cada grupo/ítem se filtra por permiso; si un grupo queda sin ítems, **no se renderiza** (sin huecos vacíos). Un SUPPORT_L1 ve una nav mínima (solo Viajes/Conductores); un SUPERADMIN ve todo.
- **Acciones in-row / in-header:** botones aparecen solo con permiso (aprobar conductor, ejecutar payout, reproducir video). Sin permiso → la celda muestra `—`, no un botón deshabilitado fantasma.
- **Estado "sin permiso" a nivel página:** cuando un rol puede llegar a la ruta pero no tiene el permiso de datos (ej. FINANCE sin `finance:view` desactivado), se muestra el `EmptyState` con candado (§1.6), nunca una tabla vacía ambigua.
- **Identidad del rol visible:** el menú de usuario (topbar) lista los roles activos del operador, para que sepa qué puede/no puede hacer.

---

## 3. FLUJOS Y PANTALLAS

> **⚠️ RECONCILIACIÓN 2026-06-29 — este §3 se actualiza a la realidad del panel y a [ADR-017](../docs/adr/017-modelo-pricing-energia-tiers.md).** El spec original (jun 25) describía el panel PRE-cadena-de-match: Finanzas = solo payout, Flota = 4 tabs, y NO mencionaba el catálogo de ofertas ni los precios. El panel ya creció con esas piezas; lo que sigue lo reconcilia. **Vocabulario canónico de la cadena de match: [`VEO_MODELO_HIBRIDO §1.5`](./VEO_MODELO_HIBRIDO.md).**

### 3.0 Mapa de Información canónico (lo que el panel DEBE tener, por grupo)

| Grupo            | Subsecciones (ruta)                                                                                                                                                               | Qué configura/muestra                                                                         | Estado del spec                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Operación**    | En vivo (`/ops`) · Métricas (`/ops/metrics`) · Viajes (`/ops/trips`) · Conductores (`/ops/drivers`) · Operadores (`/ops/operators`) · Radios de dispatch (`/ops/dispatch-radius`) | comando en vivo, KPIs, viajes, alta de conductores, gestión de operadores, radios de matching | En vivo/Viajes/Conductores ✅ abajo · **Métricas/Operadores/Radios: existen, spec pendiente** |
| **Seguridad**    | Pánicos (`/security/panics`) · Cámaras en vivo (`/security/live-wall`) · Video (`/media`)                                                                                         | cola de pánicos, muro de cámaras de viajes en curso, acceso a grabaciones (doble auth)        | Pánicos/Video ✅ abajo · **Cámaras en vivo: existe, spec pendiente**                          |
| **Flota**        | Vehículos y docs (`/fleet`) — **5 tabs**: Documentos · Vehículos · **Modelos** · Inspecciones · Vencimientos                                                                      | el carril de **OPERABILIDAD**: docs, fichas (`VehicleModelSpec`) y su aprobación              | ✅ abajo (actualizado a 5 tabs)                                                               |
| **Finanzas**     | Liquidaciones (`/finance`) · Precios y tarifas (`/finance/pricing`) · **Ofertas de servicio** (`/finance/catalog`)                                                                | payouts/refunds · fórmula GLOBAL de tarifa · catálogo de **ofertas** (tier) + su economía     | ✅ abajo (los 3)                                                                              |
| **Cumplimiento** | Auditoría (`/audit`)                                                                                                                                                              | registro WORM + verificación de cadena                                                        | ✅ abajo                                                                                      |

**Decisiones de naming (resuelven la colisión de "catálogo" — §1.5 del modelo híbrido):**

- `FLOTA → Modelos` = el **catálogo de fichas/modelos** de vehículo (`VehicleModelSpec`). En copy: "Modelos" / "fichas", **nunca "el catálogo" a secas**.
- `FINANZAS → Ofertas de servicio` (ruta `/finance/catalog`, antes rotulada "Catálogo de ofertas") = el catálogo de **ofertas** (`OfferingId`). Se **renombra** para no colisionar con el de modelos.

**Dónde vive cada config (resuelve la config por-oferta hoy PARTIDA en dos páginas):**

- **Precios y tarifas** = la fórmula **GLOBAL** (tarifa base con per-km all-in, comisión, costo/km carpooling, modo POR DEFECTO + franjas). **Sin** config por-oferta. _(Energía/combustible del pricing REMOVIDO 2026-07 — ADR-017 header.)_
- **Ofertas de servicio** = **TODO lo por-oferta** (on/off, modo override, multiplicador, tarifa mínima, **piso de puja**). Hoy el piso de puja vive en Precios → **se mueve acá**.

---

### Login / Autenticación (ruta `/login`)

- **Propósito:** autenticar personal autorizado con email + contraseña + TOTP, y enrolar TOTP la primera vez.
- **Rol(es) que la ven:** todos (puerta de entrada, pre-sesión). El layout del dashboard redirige acá si no hay sesión.
- **Entrada / Salida:** entra sin sesión (o sesión expirada) → sale a `next` (ruta destino) tras autenticar.
- **Layout & jerarquía visual:** card único centrado, ancho `max-w-sm`, sin distracciones. Cabecera con sello VEO (chip `--accent` + `ShieldCheck`) y subtítulo "Operación y Seguridad". Formulario en una columna, alto contraste, foco evidente.
- **Componentes clave:** dos fases en la misma card —
  1. **Credenciales:** email corporativo (`nombre@veo.pe`), contraseña, y campo TOTP de 6 dígitos (mono, tracking ancho, centrado) opcional para operadores ya enrolados.
  2. **Enrolamiento TOTP** (operador sin 2FA): instrucción de agregar la cuenta en Google Authenticator/Aegis, secreto base32 + enlace `otpauth` en mono seleccionable (sin QR embebido por soberanía), e input del primer código de 6 dígitos para activar.
- **Estados:** idle; pending (botón `loading`, deshabilitado sin email/contraseña); error inline bajo el campo (credenciales o código incorrecto); transición a fase enrolamiento; éxito → redirect.
- **Interacciones & transiciones:** "Continuar" valida credenciales; si falta TOTP → cambia a fase enrolamiento; "Activar y entrar" confirma el código (≥6 dígitos habilita); "Volver" regresa a credenciales limpiando código/error.
- **Contenido & copy:** "Inicia sesión", "Acceso restringido al personal autorizado de VEO.", "Configura tu autenticador", "Aún no tienes verificación en dos pasos…", "Activar y entrar".
- **Color & énfasis:** sobrio; `--accent` solo en sello y botón primario. Anillo de `--focus` (azul) visible en todos los inputs. Sin rojo salvo error real.
- **Seguridad / nota especial:** TOTP obligatorio — sin 2FA no se entra (se fuerza enrolamiento). El secreto se muestra como texto seleccionable, no es secreto de sesión. Nunca autocompletar el código de otra fuente.

---

### Shell del dashboard (layout `(dashboard)/layout.tsx`)

- **Propósito:** marco persistente de toda la app autenticada: navegación, sesión, tema, tiempo real y banner de pánico global.
- **Rol(es) que la ven:** todos los autenticados (contenido filtrado por rol).
- **Entrada / Salida:** valida sesión contra `admin-bff` server-side; sin sesión → redirige a `/login`. Provee `sessionUser` (RBAC), React Query, tema, toasts y socket `/ops`.
- **Layout & jerarquía visual:** tres zonas — **(a) Sidebar** fija 256px a la izquierda (oculta en móvil), **(b) Topbar** sticky con búsqueda y sesión, **(c) `<main>` scrolleable**. El **PanicBanner** se inserta entre topbar y main: cuando hay pánico, empuja el contenido (no flota tapando datos).
  - **Sidebar:** sello VEO arriba; grupos de nav con encabezado `uppercase` `text-[11px]` `ink-subtle` (Operación, Seguridad, Flota, Finanzas, Cumplimiento); ítem activo con `bg-accent/10 text-accent` y `aria-current="page"`. Grupos vacíos por permiso se ocultan.
  - **Topbar:** búsqueda global (viaje/conductor/ID → `/ops/trips?q=`), badge **MFA fresco/inactivo**, toggle de tema (sol/luna), menú de usuario (roles + cerrar sesión). En móvil: hamburguesa que abre la nav en un Dialog lateral.
- **Componentes clave:** Sidebar RBAC, Topbar (search + MFA badge + theme toggle + user menu), PanicBanner global, MobileNav (Dialog).
- **Estados:** sesión válida → render; sin sesión → redirect; MFA fresco (badge success) vs inactivo (badge neutral); tema light/dark persistente; conexión de socket reflejada donde aplique.
- **Interacciones & transiciones:** nav con resaltado activo por ruta (exacta para `/ops`, por prefijo para detalles); cambio de tema instantáneo; logout limpia sesión y vuelve a login.
- **Contenido & copy:** "Control de operación", grupos de nav en español, "MFA fresco" / "MFA inactivo", "Cerrar sesión".
- **Color & énfasis:** estructura en `--surface`/`--border`; acento azul solo en ítem activo y enlaces. Light y dark soportados por tokens.
- **Seguridad / nota especial:** validación de sesión server-side en cada carga (`force-dynamic`); el badge MFA comunica si el operador puede ejecutar acciones sensibles sin re-verificar.

---

### Operación en vivo (ruta `/ops`)

- **Propósito:** **centro de comando** en tiempo real — mapa de conductores, pánicos destacados, KPIs del día y viajes activos. Es la pantalla "home" del operador.
- **Rol(es) que la ven:** SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, FINANCE, ADMIN, SUPERADMIN (`ops:view`). **SUPPORT_L1 NO.**
- **Entrada / Salida:** entra desde nav; sale a detalle de pánico (clic en marcador) o a `/ops/trips` / detalle de viaje.
- **Layout & jerarquía visual:** split principal **mapa (flexible) + panel lateral 400px**; debajo, franja full-width de **tendencias** (gráfica). Header con título "Operación en vivo" y `ConnectionStatus` a la derecha.
- **Componentes clave:**
  - **Mapa en vivo** (OSM propio): marcadores de conductores (con heading/orientación) y de **pánicos** (visualmente distintos, danger). Clic en pánico → navega al detalle.
  - **KPI grid** (`KpiGrid`): Viajes activos, Conductores en línea, **Pánicos abiertos**, Completados hoy, Cancelados hoy, Recaudación hoy, ETA promedio. Cifras `tabular` `2xl`. Jerarquía por tipografía; el KPI de pánicos se enciende danger (borde + icono + número rojos) **solo si > 0**.
  - **Lista de viajes activos:** cards compactas con ID mono, `TripStatusBadge`, antigüedad relativa y monto; "Ver todos" → `/ops/trips`.
  - **Gráfica de tendencias** (recharts) con la serie del overview.
- **Estados:** loading (skeletons de KPIs y cards); vacío ("Sin viajes activos · No hay viajes en curso ahora."); error con reintento por sección; **datos en vivo** (socket: drivers/panics se actualizan; `ConnectionStatus` refleja la conexión).
- **Interacciones & transiciones:** marcadores clicables; KPIs no interactivos (lectura); navegación a detalles; actualización en streaming sin recargar.
- **Contenido & copy:** "Operación en vivo · Conductores, viajes y alertas en tiempo real.", labels de KPI en español ("Pánicos abiertos", "Recaudación hoy", "ETA promedio").
- **Color & énfasis:** base neutra; acento azul en enlaces ("Ver todos"). **Pánicos siempre danger + icono `ShieldAlert` + texto/cifra** — el KPI no comunica la alerta solo por color, sino por borde, icono y número rojos juntos.
- **Seguridad / nota especial:** los pánicos en el mapa son lectura→drill-down a la cola de atención; no se actúa desde el mapa. Datos de conductor truncados.

---

### Viajes (ruta `/ops/trips`) y Detalle de viaje (ruta `/ops/trips/[id]`)

- **Propósito:** explorar/buscar el universo de viajes y abrir el detalle operativo de uno.
- **Rol(es) que la ven:** SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`trips:view`). FINANCE no.
- **Entrada / Salida:** desde nav, búsqueda global del topbar (`?q=`) o "Ver todos" en `/ops`. Sale al detalle por fila.
- **Layout & jerarquía visual:** **Listado** = tabla densa con filtros por estado (tabs). **Detalle** = split: columna izquierda con cards "Resumen" + "Línea de tiempo", columna derecha con **mapa** (origen, destino, ubicación del conductor).
- **Componentes clave:** `DataTable` (paginable/infinite), `TripStatusBadge`, cards de detalle (`Detail` label/valor: tarifa, método de pago, pasajero, conductor, placa, ETA, distancia, creado), **timeline** vertical de estados con marcadores y timestamps tabulares, mapa con marcadores tipados.
- **Estados:** loading (skeletons de cards/mapa); vacío por filtro; error con reintento; estados de viaje vía badge (`REQUESTED → IN_PROGRESS → COMPLETED / CANCELLED`).
- **Interacciones & transiciones:** tabs filtran; clic en fila → detalle; mapa centrado en conductor/origen.
- **Contenido & copy:** "Viaje {id8}", "Resumen", "Línea de tiempo", "Sin eventos registrados."
- **Color & énfasis:** neutro; punto de timeline en `--accent`; estados por badge (texto+color).
- **Seguridad / nota especial:** sin acceso a video aquí (eso vive en Media con doble auth); nombres reales solo si el servidor los entrega, IDs truncados.

---

### Conductores (ruta `/ops/drivers`)

- **Propósito:** aprobación de altas y gestión del estado de la flota de conductores.
- **Rol(es) que la ven:** SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`drivers:view`). **Aprobar/rechazar** solo COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`drivers:approve`).
- **Entrada / Salida:** desde nav. Acciones in-row resuelven sin cambiar de página.
- **Layout & jerarquía visual:** tabla densa con tabs (Pendientes / Activos / Todos). Columna de conductor con nombre + ID mono apilados.
- **Componentes clave:** `DataTable`; columnas Conductor, Teléfono, Estado (`StatusPill`), **Rating** (2 decimales tabular), **Antecedentes** (`StatusPill` — background check), Enviado (fecha), Acciones (`DriverActions`: aprobar/rechazar gated por permiso).
- **Estados:** loading; vacío por tab ("Sin conductores · No hay conductores en esta vista."); error con reintento; acciones ocultas si falta `drivers:approve`.
- **Interacciones & transiciones:** tabs filtran por estado; aprobar/rechazar con confirmación y toast.
- **Contenido & copy:** "Conductores · Aprobación de altas y estado de la flota de conductores."
- **Color & énfasis:** rating bajo y antecedentes problemáticos se leen por `StatusPill` (texto+color), no por celda coloreada suelta.
- **Seguridad / nota especial:** aprobar un conductor es una decisión de compliance auditada; restringida por rol.

---

### Seguridad — Cola de pánicos (ruta `/security/panics`)

- **Propósito:** **atender y resolver incidentes de seguridad**. Cola de trabajo de pánicos. Corazón de la promesa de VEO en el lado operación.
- **Rol(es) que la ven:** SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`panics:view`/`ack`). **Resolver** solo COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`panics:resolve`).
- **Entrada / Salida:** desde nav, desde el **PanicBanner** global ("Atender"), o desde un marcador del mapa de `/ops`. Sale al detalle del pánico.
- **Layout & jerarquía visual:** header "Alertas de pánico"; tabs **Abiertos / Reconocidos / Todos**; tabla densa por debajo. Prioriza los abiertos.
- **Componentes clave:** `DataTable` con columnas — **Disparado** (icono `ShieldAlert` danger + tiempo relativo), Viaje (mono), Pasajero (mono truncado), Estado (`StatusPill`: Abierto=danger, Reconocido=warn, Resuelto=success), Reconocido (fecha). Clic en fila → detalle.
- **Estados:** loading; vacío ("Sin alertas · No hay alertas en esta vista."); error con reintento; el conteo/urgencia viene también del banner global y del KPI.
- **Interacciones & transiciones:** tabs filtran por estado del incidente; fila → detalle.
- **Contenido & copy:** "Alertas de pánico · Atención y resolución de incidentes de seguridad.", tabs en español.
- **Color & énfasis:** cada fila de pánico lleva **icono `ShieldAlert` + texto + tono danger** en la columna Disparado — **nunca solo color**. El estado "Abierto" es danger explícito.
- **Seguridad / nota especial:** esta cola es lectura+acción de operación; toda acción (reconocer/resolver) queda en auditoría inmutable. Datos del pasajero/conductor truncados.

#### Banner global de pánico (`PanicBanner`, transversal al shell)

- **Propósito:** alerta intrusiva pero accesible cuando entra un pánico en vivo, esté donde esté el operador.
- **Layout:** franja `role="alert" aria-live="assertive"` entre topbar y contenido (empuja, no tapa). Chip danger pulsante con `ShieldAlert` + texto **"PÁNICO ACTIVO · N alerta(s) en curso"** + metadata del viaje/estado/hora + botón **"Atender"** (danger) + descartar (X).
- **Color & énfasis:** `--danger` con icono + texto + pulso. Cumple la regla AA: tres canales simultáneos. El pulso (`animate-pulse-danger`) está reservado exclusivamente a este banner y al chip de pánico.
- **Seguridad:** "Descartar" solo lo quita del banner (no resuelve el incidente); el incidente sigue en la cola hasta resolverse.

---

### Seguridad — Detalle de pánico (ruta `/security/panics/[id]`)

- **Propósito:** ver todo el contexto de un incidente y ejecutar reconocer/resolver.
- **Rol(es) que la ven:** `panics:view`. Botón **Reconocer** con `panics:ack`; botón **Resolver** con `panics:resolve`.
- **Entrada / Salida:** desde la cola, el banner o el mapa. Acciones resuelven in-place con toast.
- **Layout & jerarquía visual:** header con breadcrumb + `StatusPill` del estado + botones de acción contextuales. Cuerpo en split: izquierda cards **"Incidente"** (viaje, pasajero, conductor, disparado, reconocido, resuelto, atendido por) + **"Evidencia"** (lista de evidencias con timestamp); derecha **mapa** centrado en la geolocalización del pánico.
- **Componentes clave:** cards `Detail`, lista de evidencia (`FileText` + label + fecha), `MapView` zoom 14, `ConfirmDialog` para Reconocer (confirmación simple) y Resolver (**con motivo/notas obligatorias**).
- **Estados:** loading (dos skeletons); error con reintento; **evidencia vacía** ("Sin evidencia · No hay evidencia asociada todavía."); botones que aparecen/desaparecen según permiso y según si ya está reconocido/resuelto.
- **Interacciones & transiciones:** "Reconocer" (primary) confirma atención; "Resolver" (secondary) abre diálogo con campo de **notas de resolución** → registra desenlace; ambos disparan toast de éxito.
- **Contenido & copy:** "Reconocer alerta · Confirmas que estás atendiendo esta alerta de pánico.", "Resolver alerta · Registra el desenlace del incidente. Esta acción queda auditada."
- **Color & énfasis:** estado y mapa con marcador de pánico danger + icono. Botones de acción con jerarquía primary/secondary.
- **Seguridad / nota especial:** reconocer y resolver son acciones auditadas; "atendido por" deja trazabilidad del operador. El motivo de resolución es parte del registro de compliance.

---

### Flota — Vehículos y documentos (ruta `/fleet`)

- **Propósito:** revisar documentos pendientes, vehículos, inspecciones y **vencimientos próximos** de la flota.
- **Rol(es) que la ven:** COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`fleet:view`). Acciones de revisión con `fleet:review`.
- **Entrada / Salida:** desde nav. Acciones de documento in-row.
- **Layout & jerarquía visual:** header "Flota"; **5 tabs**: Documentos / Vehículos / **Modelos** / Inspecciones / Vencimientos. Cada tab = tabla densa propia.
- **Componentes clave:**
  - **Documentos:** Tipo, Titular (Conductor/Vehículo + ID), Estado (`StatusPill`), Vence (fecha), Acciones (`DocumentActions`).
  - **Vehículos:** Placa (mono), Vehículo (marca+modelo+año), Color, **Operabilidad** (veredicto DERIVADO: Operable / No operable + motivo `Sin ficha` o `Docs vencidos` — espeja `isVehicleOperable`, ver `VEO_MODELO_HIBRIDO §1.5`), **Ofertas que califica** (los `OfferingId` cuyos `requires` cumple la **ficha** del vehículo — distinto de operabilidad), Conductor. ⚠️ "Operable" y "califica para la oferta X" son **dos columnas distintas**: un vehículo operable no está matcheado a toda oferta.
  - **Modelos** (catálogo de **fichas** `VehicleModelSpec`): subtabs **Por revisar / Aprobados**. _Por revisar_ = modelos que un conductor solicitó y aún no están en el catálogo (marca/modelo/años + segment/seats/energía propuestos) → aprobar/rechazar (`fleet:review`). **Aprobar re-linkea** atómicamente los vehículos que encolaron ese modelo → cierra el hueco de operabilidad (`modelSpecId`). Empty: "Sin modelos pendientes · cuando un conductor solicite un **modelo** que no está en el catálogo de fichas, aparece acá."
  - **Inspecciones:** Vehículo, Estado, Programada, Realizada, Inspector, Resultado.
  - **Vencimientos:** Tipo, Titular, Vence, y **Días restantes** con **semáforo accesible**: ≤7 días = danger + icono `AlertTriangle`; ≤30 días = warn (texto); resto = neutro. El icono acompaña al texto en urgentes.
- **Estados:** loading; vacíos por tab ("Sin documentos pendientes", "Sin vencimientos próximos · Ningún documento vence pronto."); error con reintento.
- **Interacciones & transiciones:** tabs cambian dataset; aprobar/rechazar documentos con confirmación; revisión gated por permiso.
- **Contenido & copy:** "Flota · Documentos, vehículos, **modelos/fichas**, inspecciones y vencimientos próximos.", "{n} d" para días restantes.
- **Color & énfasis:** urgencia de vencimiento por **icono + color + número** (≤7d danger con `AlertTriangle`), nunca color solo. Estados por `StatusPill`.
- **Seguridad / nota especial:** los vencimientos son compliance crítico (SOAT, licencia, tarjeta de propiedad) — la urgencia debe leerse de un vistazo y de forma accesible. **Operabilidad ≠ elegibilidad de oferta** (`VEO_MODELO_HIBRIDO §1.5`): el veredicto de Operabilidad (docs + ficha) responde "¿puede operar?", NO "¿califica para la oferta X?". El panel muestra AMBAS; un operador no debe leer "Operable" como "matchea todas las ofertas".

---

### Finanzas — Liquidaciones (ruta `/finance`)

- **Propósito:** gestionar payouts a conductores y reembolsos a pasajeros.
- **Rol(es) que la ven:** FINANCE, ADMIN, SUPERADMIN (`finance:view`). **Ejecutar payout (`finance:payout`) SOLO FINANCE.** **Iniciar un reembolso = `finance:refund`** (FINANCE / ADMIN / SUPERADMIN); SUPPORT **no** ejecuta reembolsos. Refunds sobre umbral → dual-control (ver Seguridad).
- **Entrada / Salida:** desde nav. Acciones in-row / in-header (refund).
- **Layout & jerarquía visual:** header "Liquidaciones" con acción de reembolso a la derecha (si permiso); tabs **Pendientes / Pagadas / Todas**; tabla densa.
- **Componentes clave:** `DataTable` — Liquidación (ID mono), Conductor (ID mono), Periodo, **Monto** (`money` PEN, tabular, medium), Estado (`StatusPill`), Acciones (`PayoutActions`). Header: `RefundDialog`.
- **Estados:** **sin permiso a nivel página** → `EmptyState` con candado ("Acceso restringido · Necesitas el rol FINANCE para ver liquidaciones y reembolsos."); loading; vacío por tab ("Sin liquidaciones"); error con reintento. La columna Acciones muestra `—` si el rol no es FINANCE o si el payout no está pendiente.
- **Interacciones & transiciones:** tabs filtran; **"Ejecutar"** abre `ConfirmDialog` que muestra monto + conductor + periodo y advierte idempotencia; al confirmar genera `idempotencyKey` (UUID) y dispara toast.
- **Contenido & copy:** "Liquidaciones · Pagos a conductores y reembolsos a pasajeros.", "Ejecutar liquidación · Se transferirá {monto} al conductor {id8} (periodo {p}). Esta acción es idempotente.", "Ejecutar pago".
- **Color & énfasis:** sobrio; montos en tinta primaria tabular; estado por badge. Sin rojo salvo fallo real.
- **Seguridad / nota especial:** **payout es financiero idempotente** (`dedup_key`/`idempotencyKey`) — el copy lo comunica. Por brief, payouts > S/5K requieren **step-up MFA**: el diseño debe prever que la acción de ejecutar pueda exigir re-verificación TOTP (badge MFA fresco en topbar) antes de transferir montos altos. Ejecutar es exclusivo de FINANCE: ni ADMIN ni SUPERADMIN ven el botón.
- **Seguridad / nota especial — REFUND (money-OUT, ADR-017/022 · decisión 2026-07-02 opción A):** todo reembolso exige **step-up MFA fresca** (`StepUpDialog`, no un `ConfirmDialog` simple). **Dual-control por umbral:** un refund **> `REFUND_L2_THRESHOLD_CENTS`** NO lo completa un solo operador — queda en estado **"Pendiente de 2da aprobación"** y necesita un **segundo aprobador ADMIN/SUPERADMIN** (separación de funciones en dinero que SALE). La UI DEBE renderizar ese estado (badge/StatusPill "Requiere 2da aprobación" + acción "Aprobar" visible solo al 2º aprobador con permiso). Refunds bajo el umbral: `finance:refund` + MFA, un solo aprobador.

---

### Finanzas — Precios y tarifas (ruta `/finance/pricing`)

- **Propósito:** configurar la fórmula **GLOBAL** de precio (NO por-oferta): modo por defecto, componentes de la tarifa on-demand (base + per-km all-in + per-min), costo/km del carpooling y comisión. Es el carril de pricing del DAG de configuración (`VEO_MODELO_HIBRIDO §1.5`). _(El modelo de energía/combustible del pricing fue REMOVIDO 2026-07 — el per-km all-in vive en la Tarifa base, ADR-017 header.)_
- **Rol(es) que la ven:** FINANCE, ADMIN, SUPERADMIN (`pricing:view`; editar con `pricing:edit`).
- **Entrada / Salida:** desde nav (Finanzas). Cada bloque guarda por separado.
- **Layout & jerarquía visual:** secciones apiladas, cada una versionada (patrón singleton + `version` + outbox, auditada): **Modo de tarifa · on-demand** (modo por defecto Puja/Fijo + franjas horarias) · **Componentes de la tarifa · on-demand** (tarifa base: banderazo/km all-in/min — el per-km ya lleva todo el costo, sin bloque de energía separado) · **Carpooling · programado** (costo de operación por km, escudo cost-sharing, por país) · **Comisión · ambos modos** (on-demand: descuento al conductor · carpooling: service fee al pasajero).
- **Componentes clave:** cada bloque = card con inputs numéricos + "Guardar" (disabled sin cambios) + sello "Versión {n} · actualizado {fecha}".
- **Estados:** loading; error con reintento; "sin permiso" → `EmptyState` con candado; éxito → toast + bump de versión.
- **Interacciones & transiciones:** guardar es inmediato, server-side y queda auditado; el cambio rige global.
- **Contenido & copy:** "Precios y tarifas · Cómo se calcula y se cobra cada viaje: modo, componentes on-demand, costo del carpooling y comisión."
- **Color & énfasis:** sobrio; montos tabulares; sin rojo salvo error.
- **Seguridad / nota especial — regla de coherencia (resuelve una incoherencia real del panel):**
  - **Esta página NO lleva config por-oferta.** El multiplicador, la tarifa mínima y el **piso de puja** por oferta viven en **Ofertas de servicio**. El "modo por defecto" de acá es el GLOBAL; el override de modo por oferta vive en Ofertas. (Resuelve el "modo en dos lugares" y los "dos mínimos por oferta".)
    > _(La regla previa "sin control muerto — Recargo de combustible legacy / `PRICING_ENERGY_MODEL_ENABLED`" quedó MOOT 2026-07: el pricing por energía/combustible fue REMOVIDO — no hay panel de energía ni de recargo de combustible que colapsar. El per-km all-in vive en la Tarifa base. Ver ADR-017 header.)_

---

### Finanzas — Ofertas de servicio (ruta `/finance/catalog`)

- **Propósito:** activar/desactivar cada **oferta** (`OfferingId`: VEO*MOTO/ECONÓMICO/NORMAL/XL/PREMIUM…) y fijar SU economía y SU modo. El pasajero ve/cotiza/pide solo lo habilitado. *(Antes rotulada "Catálogo de ofertas" — **renombrada** para no colisionar con el catálogo de **modelos** de Flota; ver §3.0.)\_
- **Rol(es) que la ven:** FINANCE, ADMIN, SUPERADMIN (`catalog:view`; editar con `catalog:edit`).
- **Entrada / Salida:** desde nav (Finanzas). Guarda por oferta.
- **Layout & jerarquía visual:** lista de ofertas; cada una = card con Clase (`MOTO`/`CAR`), estado (Habilitada/Deshabilitada + toggle), **Modo** (override por oferta: Automático-según-horario / Puja / Precio fijo, restringido a lo que la oferta permite), **Multiplicador** (vacío = valor de código), **Tarifa mínima** (vacío = valor de código), **Piso de puja** (vacío = usa el default de Precios). Sello de versión global.
- **Componentes clave:** card por oferta con inputs + "Guardar" por card; badge de estado.
- **Estados:** loading; error con reintento; "sin permiso" → candado; éxito → toast + bump de versión.
- **Interacciones & transiciones:** cambios inmediatos, server-side, auditados; el `Modo` se restringe a lo que cada oferta permite.
- **Contenido & copy:** "Ofertas de servicio · Activá o desactivá cada oferta (VEO Moto, Económico, Normal, Premium, XL…). El pasajero ve solo lo habilitado."
- **Color & énfasis:** sobrio; estado por badge (texto + color).
- **Seguridad / nota especial — la frontera con el código:** el SET de ofertas, la `VehicleClass` y los `requires` (minSeats/minSegment/maxAge/certs) viven **EN CÓDIGO** (ADR-013, no editables acá); esta pantalla cura solo **visibilidad + economía** (toggle, modo, multiplicador, mínimo, piso). **TODA** la config por-oferta vive acá (no partida con Precios). La **elegibilidad** de un vehículo para una oferta la decide su **ficha** (segment/seats) vs los `requires`, NO esta pantalla — ver `VEO_MODELO_HIBRIDO §1.5`.

---

### Media — Acceso a video (ruta `/media`)

- **Propósito:** solicitar, aprobar/rechazar y **reproducir** grabaciones de viajes bajo **doble autenticación** (compliance Ley 29733).
- **Rol(es) que la ven:** COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`media:view`/`request`/`approve`).
- **Entrada / Salida:** desde nav (grupo Seguridad → "Video"). Solicitar (header) y aprobar/reproducir (in-row).
- **Layout & jerarquía visual:** header "Acceso a video" con acción "Solicitar acceso" (si permiso); tabs **Pendientes / Aprobadas / Rechazadas**; tabla densa.
- **Componentes clave:** `DataTable` — Viaje (mono), **Motivo**, Solicitante (ID mono), Estado (`StatusPill`), Solicitado (fecha), Acciones (`MediaActions`). `RequestAccessDialog` para crear solicitud. `MediaPlayer` (modal) con **watermark visible no removible** + nota de expiración.
- **Estados:** loading; vacío por tab ("Sin solicitudes"); error con reintento; acciones según estado (PENDING→aprobar/rechazar; APPROVED→reproducir) y permiso.
- **Interacciones & transiciones:** **Aprobar** y **Reproducir** abren `StepUpDialog` (TOTP) → solo tras verificar ejecutan la acción; rechazar con `ConfirmDialog` variante danger. El reproductor muestra URL firmada temporal con watermark rotado + esquina, y aviso "Acceso temporal · expira {fecha}. Toda reproducción queda auditada."
- **Contenido & copy:** "Acceso a video · Solicitud y aprobación de acceso a grabaciones (doble autenticación).", "Aprobar acceso a video · Aprobar el acceso a grabaciones requiere verificación adicional.", "Reproducir video · …Toda reproducción queda auditada."
- **Color & énfasis:** sobrio; acción primaria en azul; rechazo en danger explícito (texto + variante). El watermark sobre el video es un elemento de diseño obligatorio.
- **Seguridad / nota especial:** **doble auth real** — permiso RBAC + **step-up MFA fresco** por cada aprobación/reproducción. URL firmada con expiración. **Watermark visible permanente** (operador + contexto) sobre todo frame, no removible. Toda reproducción se audita. Este es el punto más sensible del dashboard (PII en video de cabina).

---

### Auditoría (ruta `/audit`)

- **Propósito:** consultar el **registro inmutable append-only** con cadena de hash, y **verificar su integridad** (compliance Ley 29733).
- **Rol(es) que la ven:** COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN (`audit:view`). **Verificar cadena** con `audit:verify`.
- **Entrada / Salida:** desde nav (grupo Cumplimiento). Búsqueda y paginación in-page.
- **Layout & jerarquía visual:** header "Auditoría" con botón "Verificar cadena" (si permiso); **banda de resultado de verificación** (status) bajo el header cuando se ejecuta; buscador; tabla densa paginada ("Cargar más").
- **Componentes clave:** `DataTable` — **Seq** (mono tabular), Fecha, Acción, Recurso (tipo + ID), Actor (ID mono o "sistema"). Buscador por acción/recurso/actor. Botón verificar con resultado.
- **Estados:** loading (Suspense "Cargando…"); vacío ("Sin registros"); error con reintento; **resultado de verificación**: íntegra (success + `ShieldCheck`) vs comprometida (danger + `ShieldX`, indica seq de ruptura); paginación incremental.
- **Interacciones & transiciones:** buscar aplica filtro al enviar; "Verificar cadena" valida la hash-chain y muestra "{n} entradas verificadas · {fecha}" o la ruptura; "Cargar más" pagina.
- **Contenido & copy:** "Auditoría · Registro append-only con cadena de hash verificable.", "Cadena íntegra" / "Cadena comprometida · ruptura en seq {n}", "{n} entradas verificadas".
- **Color & énfasis:** la banda de verificación es el único punto de color fuerte — **success con icono `ShieldCheck`** o **danger con icono `ShieldX`** (texto + icono + color, AA). Tabla neutra.
- **Seguridad / nota especial:** registro **inmutable** — solo lectura, jamás edición/borrado desde la UI. La verificación de hash-chain es la garantía de no-manipulación (S3 Object Lock, retención 7 años). El actor "sistema" distingue acciones automáticas de las humanas.

---

## 4. Resumen de patrones reutilizables (para el diseñador)

| Patrón                        | Componente                              | Dónde se usa                                                      |
| ----------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Tabla densa ordenable         | `DataTable`                             | Viajes, Conductores, Pánicos, Flota×4, Finanzas, Media, Auditoría |
| Estado de dominio             | `StatusPill` (texto+color)              | Todas las tablas                                                  |
| Filtro por estado             | `Tabs`                                  | Pánicos, Conductores, Flota, Finanzas, Media                      |
| Vacío / Error / Sin permiso   | `EmptyState` / `ErrorState` / candado   | Todas                                                             |
| Loading                       | `Skeleton` con silueta real             | Todas                                                             |
| Confirmación con consecuencia | `ConfirmDialog` (+motivo opcional)      | Resolver pánico, payout, rechazar media, refund                   |
| Doble auth de acción sensible | `StepUpDialog` (TOTP fresco)            | Aprobar/reproducir video, payout alto                             |
| Alerta crítica accesible      | `PanicBanner` (icono+texto+color+pulso) | Shell global                                                      |
| Estado de tiempo real         | `ConnectionStatus` (punto+texto)        | Ops                                                               |
| Detalle label/valor           | `Detail` (mono para datos técnicos)     | Detalle de pánico y de viaje                                      |

**Regla de oro transversal:** ningún estado crítico (pánico, vencimiento ≤7d, cadena comprometida, error, sin conexión) se comunica solo por color — siempre **icono + texto + color** juntos.
