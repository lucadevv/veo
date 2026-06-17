# ADR 011 — Switch PUJA ↔ PRECIO-FIJO controlado por ADMIN (por horario/zona)

> Estado: **RATIFICADO** (spec sin código). Decisiones §8 cerradas. Próximo: tasks → apply.
> Permite que el ADMIN decida —por horario (y a futuro por zona)— si un viaje nuevo nace como
> **PUJA** (ADR 010, "proponé tu precio") o **PRECIO FIJO** (tarifa calculada estilo Uber), en vez de
> que lo decida el cliente.

---

## 0. Contexto y problema

Hoy el modo es **CLIENT-DRIVEN**: `trips.service.ts:195` ramifica por la **presencia de `dto.bidCents`** —
si el pasajero manda un bid → PUJA (`emitBidPosted`); si no → FIJO (`calculateFare` + `emitTripRequested`).
No hay política server-side: la app decide.

El dueño quiere **decidir el modo desde el admin, por horario** (ej. puja en horas pico, fijo en valle).
Para eso el **SERVIDOR** debe resolver el modo desde `{zona, hora, config-admin}` y **forzarlo**, ignorando
lo que mande el cliente.

**Lo que YA está (el 60%, la parte cara):**

- **Dos motores funcionando** detrás de **dos eventos**: PUJA (`trip.bid_posted` → OfferBoard) y FIJO
  (`trip.requested` → matching secuencial). Strangler-fig limpio (ver ADR 010).
- **El punto de fork único**: `trips.service.ts:195`. Reemplazar la condición es todo el cableado de lógica.

**Lo que FALTA (el 40%, plumbing):** el resolver server-side + la config admin + el modelo de zona +
persistir el modo en el viaje.

---

## 1. Decisión arquitectónica

### 1.1 Patrón: `ModeResolver` (NO Strategy)

La selección es una decisión de **enum de 2 vías por data** (zona, hora, config). Eso es un
**resolver que devuelve un enum + el `if/else` que YA existe** — NO objetos Strategy (sería ceremonia: los
dos comportamientos ya viven como dos métodos y dos consumers). **Se reserva Strategy para un 3er modo**
(híbrido/surge-puja); recién ahí el branch se vuelve polimórfico y Strategy paga. No se pre-construye.

```ts
// en trip-service, consumido por createTrip (reemplaza el `if (dto.bidCents !== undefined)`)
resolvePricingMode(zone: ZoneKey, now: Date): 'PUJA' | 'FIXED'
```

### 1.2 La regla de oro: **resolve-once-persist-forever**

> El modo se resuelve **UNA vez, en `createTrip`**, y el viaje **lo carga toda su vida** en una columna
> `Trip.dispatchMode`. La reasignación y la activación de programados leen el modo **DEL VIAJE**, NUNCA
> re-resuelven de la config actual.

**Por qué (la trampa):** un viaje creado en ventana de puja, cuyo conductor cancela después de que el admin
pasó la zona a fijo a las 21h, **NO debe re-abrir una puja bajo política fija** (ni al revés). El viaje es
inmutable en su modo. Sin esto, un flip de config a media-vida corrompe viajes en vuelo.

---

## 2. Dominio (PLAYBOOK §2)

| Entidad               | Dueño         | Qué es                                                             |
| --------------------- | ------------- | ------------------------------------------------------------------ |
| `PricingMode`         | shared-types  | `'PUJA' \| 'FIXED'`                                                |
| `Trip.dispatchMode`   | trip-service  | el modo CONGELADO del viaje (columna nueva)                        |
| `PricingModeSchedule` | admin (nuevo) | reglas `{ dayMask, startMinute, endMinute, mode }` + `defaultMode` |
| `ZoneKey`             | maps/shared   | clave de zona (MVP: global; futuro: celda H3 / zona nombrada)      |

- **Schedule (MVP Tier 1 — global por horario):** una lista de reglas horarias + un `defaultMode`. La
  primera regla que matchea `(día, hora)` gana; si ninguna → `defaultMode`. Aplica a toda la ciudad.
- **Zona (futuro Tier 2):** el resolver YA recibe `zone`, pero el MVP la ignora (global). Agregar overrides
  por zona después es no-breaking (el resolver ya tiene el parámetro).

---

## 3. Arquitectura de acceso + propagación (MENTORIA · efecto dominó)

```
ADMIN edita schedule          admin-bff (módulo pricing NUEVO)        trip-service
   │  POST /admin/pricing/mode-schedule  (ROL: admin/pricing)            │
   ├──────────────────────────►│ valida + persiste (DB admin)           │
   │                           ├── emite `pricing.mode_schedule_updated`─►│ proyección local
   │                           │     (outbox → Kafka)                     │ (read-model, patrón
   │                           │                                          │  DriverProjectionService)
PASAJERO pide quote            │                                          │
   │  GET /maps/quote ─────────► public-bff ── consulta modo ────────────►│ resolvePricingMode(zone,now)
   │◄── { mode, fixedQuote? | bidFloor/suggested } ──────────────────────┤  (lee la proyección)
   │  crea viaje según el modo │                                          │ createTrip: RE-RESUELVE
   │  POST /trips ─────────────► public-bff ─────────────────────────────►│  (autoritativo) + PERSISTE
   │                           │                                          │  dispatchMode + emite el evento
```

- **El schedule lo OWNE `trip-service`** (refinamiento vs draft: `admin-bff` es **stateless**, no tiene DB
  → no puede ser la fuente). trip-service es el resolver, así que co-locar el schedule ahí evita un hop de
  red por cada `createTrip` y la ceremonia de un event-projection (§4-bis: no metas proyección si UN solo
  servicio consume la config). trip-service expone endpoints internos `GET/PUT /internal/pricing/mode-schedule`
  - `GET /internal/pricing/resolve`. `admin-bff` (módulo `pricing` nuevo) es un **proxy CRUD con RBAC**
    (`pricing:manage`/`view`) hacia esos endpoints — la UI refleja, el gate va server-side (admin-bff Y
    re-validado en el endpoint interno de trip). El evento `pricing.mode_schedule_updated` se emite en el PUT
    (audit + consumidores futuros), pero NO es load-bearing: el resolver lee la tabla local de trip-service.
    Degradación honesta: sin schedule cargado → `defaultMode` (PUJA).
- **El pasajero aprende el modo** vía el quote (`GET /maps/quote` devuelve `mode`): si FIXED → muestra la
  tarifa fija; si PUJA → muestra "proponé tu precio" con piso/sugerido. La UI refleja, NO autoriza — el
  modo autoritativo se RE-RESUELVE en `createTrip` (el quote es una pista; entre quote y create pudo cambiar).

---

## 4. El cambio en `createTrip` (el fork)

```ts
// ANTES (client-driven):
if (dto.bidCents !== undefined) { isBid = true; ... } else { fare = calculateFare(...); isBid = false; }

// DESPUÉS (server-resolved + persist):
const mode = this.modeResolver.resolve(toZone(origin), now);   // PUJA | FIXED (autoritativo)
const dispatchMode = mode;                                     // se congela en la fila Trip
if (mode === 'PUJA') {
  // valida dto.bidCents (piso ≤ bid ≤ techo); emite trip.bid_posted
} else {
  // IGNORA dto.bidCents; fare = calculateFare(...); emite trip.requested
}
// Trip.create({ ..., dispatchMode })
```

- **reassign / scheduled-activation** leen `trip.dispatchMode` (NUNCA re-resuelven). `reassignAfterDriverCancel`
  re-emite el evento del **modo del viaje**; el scheduler de programados activa con el modo congelado.
  (Hoy los programados caen siempre a `trip.requested` — esto se corrige: respetan su `dispatchMode`.)

---

## 5. Caminos infelices (PLAYBOOK §5.3)

| ¿Y si…?                                            | Resultado                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| no hay config/proyección todavía                   | `defaultMode` (degradación honesta, no crash)                                                |
| el admin flipea el modo con viajes en vuelo        | los en vuelo conservan su `dispatchMode` (persist-once); solo los NUEVOS toman el modo nuevo |
| el pasajero manda `bidCents` pero el modo es FIXED | se IGNORA el bid; tarifa calculada (la app ya mostró fijo vía el quote)                      |
| el pasajero NO manda bid pero el modo es PUJA      | el quote ya pidió el bid; si falta → 400 "falta tu oferta" (no se asume un precio)           |
| zona desconocida (MVP global)                      | usa el schedule global                                                                       |
| reasignación tras flip de config                   | re-abre en el modo del VIAJE, no en el de la config actual                                   |

---

## 6. Acceso (matriz, capa 2+3)

| Capacidad                                         | ROL                                                       | Regla server-side                                     |
| ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Ver el schedule de modo                           | admin (cualquier sub-rol con `pricing:view`)              | —                                                     |
| Editar el schedule (crear/borrar reglas, default) | admin con `pricing:manage` (¿FINANCE? ¿ADMIN/SUPERADMIN?) | RBAC en admin-bff + re-valida en el service           |
| Resolver el modo (lectura)                        | interno                                                   | trip-service desde su proyección; public-bff vía trip |

> La UI del admin refleja; el gate de `pricing:manage` va server-side. El pasajero NO elige el modo.

---

## 7. Puntos de integración (para tasks — NO es código aún)

- **packages/shared-types**: `PricingMode`. **packages/events**: `pricing.mode_schedule_updated`.
- **trip-service**: columna `Trip.dispatchMode`; `ModeResolver` + proyección del schedule (consumer del
  evento admin); `toZone(origin)` (MVP: devuelve la zona global); `createTrip` re-resuelve + persiste;
  reassign/scheduled leen `dispatchMode`; endpoint interno `resolveMode(origin,now)` para el public-bff.
- **admin-bff**: módulo `pricing` (CRUD del schedule + RBAC `pricing:*`); emite el evento por outbox.
- **public-bff**: el quote (`/maps/quote`) devuelve `mode` (+ fixedQuote o bidFloor/suggested según el modo).
- **admin-web / apps**: UI del schedule (admin) + la app pasajero muestra la pantalla según `mode` (lote apps).

---

## 8. Decisiones de producto — RATIFICADAS (2026-06-04)

1. **Alcance MVP**: **Tier 1 — schedule GLOBAL por horario.** El resolver recibe `zone` pero el MVP la
   ignora (overrides por zona = follow-up no-breaking).
2. **Modo por defecto** (ninguna regla matchea / sin config / proyección no cargada): **PUJA.** VEO es puja;
   el fijo es la excepción programada. Degradación → puja.
   > **ENMIENDA B5 (2026-06-16):** postura de producto **INVERTIDA** a pedido del cliente. El default del
   > sistema pasa a ser **FIXED (precio fijo)**; la **PUJA es la excepción programada** por horario en el
   > panel admin. `DEFAULT_SCHEDULE.defaultMode = FIXED` y la degradación honesta cae a FIXED. El mecanismo
   > (schedule + reglas por horario, resolve-once-persist-forever) NO cambia — solo el valor por defecto.
3. **Forma del schedule**: **día-de-semana (`dayMask`) + rango horario** (`startMinute`/`endMinute` en hora
   local de Lima). Cubre pico-laboral vs finde.
4. **Quién edita**: permiso **`pricing:manage`** → roles **ADMIN, SUPERADMIN, FINANCE** (el pricing es
   decisión financiera/comercial). `pricing:view` para lectura.

_(El persist-once en `Trip.dispatchMode` NO es pregunta — es la regla de oro, va sí o sí.)_

---

_Decisión: ModeResolver (no Strategy) + persist-once en el Trip. El 60% (dos motores + fork) ya está;
falta el resolver + config admin + zona + persistir. Próximo: ratificar §8 → tasks → apply._
