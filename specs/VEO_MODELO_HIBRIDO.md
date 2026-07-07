# VEO — Modelo Híbrido (Carpooling + On-Demand + Seguridad + Multipaís)

> **Fuente de verdad del PRODUCTO.** Sintetizado de: el design de referencia `design/BlaBlaCar ios May 2026/` (197 pantallas, recorridas 1×1), los specs existentes (`VEO_SPEC_PASAJERO/CONDUCTOR/FAMILIA/ADMIN.md`) y el código real del monorepo.
> **Estado (2026-06-25):** en las **apps**, VEO hoy es ride-hailing **on-demand** (Uber/inDriver-like) con seguridad — el carpooling **todavía no tiene UI**. PERO el **cimiento backend del carpooling YA está construido**: `booking-service` (servicio nuevo, REST 3016 / gRPC 50054) es dueño de `PublishedTrip` + `Booking` con sus máquinas de estado tipadas, e implementa **F0** (cimiento de datos) y el **backend completo de F3** (reservar→aprobar→cobrar con **charge-on-approval sin hold**, ADR-014). Lo que falta es la **UI de las apps** (publicar/buscar/reservar en mobile) + cablearlo en el dev-stack. Este doc define el **marketplace de viajes seguros multi-modo** y marca, por fase, qué tiene backend hecho vs UI pendiente.
> **Mercado:** Perú primero → Ecuador. Español peruano/ecuatoriano.

---

## 0. El hallazgo que ancla todo (pricing)

**BlaBlaCar es 100% PRECIO FIJO. NO tiene puja/negociación.**

- El conductor fija el precio por asiento al publicar, con **rango recomendado** (verde/rojo) y **tope de cost-sharing** ("our community is about cost-sharing, not making money").
- Único mecanismo tipo-oferta: **"special request top-up"** — el pasajero ofrece +X sobre la base por pickup distinto/equipaje → el conductor aprueba. Unidireccional, aditivo.
- Salirse del precio publicado = **fraude reportable** ("charging more than listing", "driving for profit").

→ **El carril de PUJA (inDrive: el pasajero propone precio, el conductor acepta/contraoferta) NO existe en el design. Es diseño NUEVO de VEO** (§8.2). BlaBlaCar solo cubre el carril FIJO.

---

## 1. El modelo en una mirada

**VEO = marketplace de viajes seguros con conductores VERIFICADOS · 2 modos × pricing dual · seguridad transversal · multipaís.**

| Eje                                       | Opciones                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modo de viaje**                         | **🗓️ PROGRAMADO** (carpooling: conductor publica → pasajero busca → reserva asiento; multi-pasajero; intercity) · **⚡ AHORA** (on-demand: dispatch 1-a-1; urbano; YA construido)                  |
| **Pricing**                               | **FIJO** (lo fija el conductor/sistema; rango recomendado; en carpooling con tope cost-sharing) · **PUJA** (el pasajero propone → el conductor acepta/contraoferta; inDrive; **NUEVO**)            |
| **Seguridad (transversal a ambos modos)** | pánico invisible · cámara de cabina en vivo · gate biométrico por turno · familia-share · modo niño · contactos de confianza · KYC liveness · Verified Profile (ID/email/teléfono + SOAT/licencia) |
| **País**                                  | Perú (S/, DNI/TIVe/SOAT, Yape/Plin) → Ecuador (USD, cédula, rails locales)                                                                                                                         |

**El diferenciador (el moat):** BlaBlaCar es entre **pares sin verificar**; inDrive no tiene seguridad fuerte. VEO = **carpooling/viajes con conductores VERIFICADOS + seguridad en vivo** → más seguro que BlaBlaCar, más completo que inDrive. La fundación de seguridad que YA está construida (pánico, cámara, biometría, familia, modo niño) es la ventaja.

---

## 1.5 Diccionario de la cadena de match (vocabulario canónico)

> **Fuente única del vocabulario.** ADR-013/014/017 y `VEO_SPEC_ADMIN` referencian ESTA sección; si un doc usa otro término, gana este. Consolida ADR-017 §1.9 (el DAG de config) + §5 (la cadena) + la enmienda de ADR-014 (operabilidad).

**La regla del negocio:** _un vehículo debe matchear su configuración admin ANTES de poder operar o iniciar un viaje._ Pero "match" NO es una cosa: es una **cadena** de eslabones, y dos de ellos son **gates distintos que se confunden**. Este diccionario los separa.

### Los términos (no son sinónimos)

| Término canónico                                                          | Qué es (tipo en código)                                                               | Quién lo fija                      | Gobierna                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------- |
| **Categoría MTC**                                                         | clasificación legal (M1/N1/L5…), del OCR de la TIVe                                   | el Estado (documento)              | deriva la **Clase**                 |
| **Clase** (`VehicleClass` ≡ `vehicleType`: `MOTO`\|`CAR`)                 | enum **CERRADO**; la "key" del pool de matching                                       | derivada de la categoría MTC       | match DURO de pool (fail-closed ✅) |
| **Ficha** (`VehicleModelSpec`)                                            | marca/modelo/años + **segment** + **seats** + **energía**; la **APRUEBA el operador** | operador (aprueba el modelo)       | **OPERABILIDAD**                    |
| **Oferta** (`OfferingId`: `VEO_MOTO`/`ECONOMICO`/`NORMAL`/`XL`/`PREMIUM`) | catálogo tipado **EN CÓDIGO** + sus `requires` (minSeats/minSegment/maxAge/certs)     | release (código), **NO** operación | **ELEGIBILIDAD de oferta (tier)**   |

> ⚠️ **"Catálogo" es ambiguo — desambiguar SIEMPRE:** el \*catálogo de **modelos\*** (las fichas `VehicleModelSpec` aprobadas, en FLOTA) ≠ el \*catálogo de **ofertas\*** (los `OfferingId` de servicio, en código). En el panel se renombran para no colisionar (ver `VEO_SPEC_ADMIN`).
>
> ⚠️ **"Tier" es ambiguo — reservado:** "tier" = calidad de **oferta** (Económico→Premium). El "tier de antelación / refund por tier" de ADR-014 (reembolso según cuánto se anticipa la cancelación) se renombra a **"ventana de cancelación"** — NO es un tier.

### Los dos gates que se confunden

| Gate                       | Pregunta                                          | Predicado                                                                                              | Estado HOY                                                                      |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Operabilidad**           | ¿este vehículo **puede operar**?                  | SOAT + ITV vigentes **+ ficha (`modelSpecId`) linkeada** + `docStatus ≠ EXPIRED` (`isVehicleOperable`) | **ENFORCED fail-closed ✅** punta a punta (fleet REST/gRPC + booking)           |
| **Elegibilidad de oferta** | ¿este vehículo **califica para la oferta VEO_X**? | el `segment`/`seats` de su **ficha** cumple los `requires` de la oferta                                | **INSTRUMENTED fail-open ❌** en dispatch — y peor, **desacoplado** (ver abajo) |

**Un vehículo "operable" NO está "matcheado a todas las ofertas".** Son dos preguntas distintas. El panel debe mostrar AMBAS (hoy muestra solo operabilidad → de ahí la confusión).

### La cadena (DAG de configuración — ADR-017 §1.9)

```
catálogo de MODELOS (fichas aprobadas) → OFERTAS/clases (requires)
   → tarifa base → costo/km → modo → comisión   →   dispatch / booking
```

> _(El eslabón `energía-con-precio →` inicial se ELIMINÓ 2026-07: el modelo de energía/combustible del PRICING fue REMOVIDO — la tarifa on-demand usa un solo per-km all-in en la tarifa base. El `EnergySource` de la **ficha del vehículo** — fila de la tabla de arriba — NO era pricing y sigue. Ver ADR-017 header.)_

El operador configura en ESTE orden ("admin primero"): sin ficha aprobada el vehículo no es operable; sin oferta no hay tier que matchear.

### Dónde vive cada config (código vs admin-DB)

- **EN CÓDIGO** (cambian al ritmo de releases, no de operación — ADR-013 §1, YAGNI): el set de `OfferingId`, la `VehicleClass`, y los `requires` de cada oferta. El admin solo cura **visibilidad** (overrides) y la **economía** por oferta.
- **EN ADMIN-DB** (editable en caliente — ADR-017): tarifa base (con per-km all-in), comisión, costo/km (carpooling), modo, y la **aprobación de fichas** (`VehicleModelSpec`). _(Los "precios de energía" del pricing se removieron 2026-07 — el per-km all-in vive en la tarifa base; ADR-017 header.)_

### El desacople (la deuda DURA del match — ADR-017 §5)

El tier-gate de dispatch lee `seats`/`segment`/`vehicleYear` del **ping de GPS** (`driver.location_updated`, los tres `.optional()`). Matiz importante: el ping es **transporte**, no la fuente — el `active-vehicle-type.resolver` del driver-bff resuelve esos attrs **de la ficha aprobada** (`VehicleModelSpec`, vía fleet REST `/drivers/vehicles/active`) y los **sella server-authoritative** en cada ping (la app del conductor NO los auto-reporta). El riesgo real era más estrecho: el **carry anti-clobber** del hot-index (que preserva los attrs cuando un ping llega degradado sin ellos) se llaveaba por `vehicleType` (`VehicleClass`), que no distingue dos vehículos de la misma clase → un swap intra-clase + ping degradado arrastraría attrs STALE.

> **Prerequisito de identidad — ✅ HECHO (commit `73dfc9c`):** el carry se llavea por `vehicleId` (IDENTIDAD del vehículo activo, sellado en el firehose), con fallback por compat a `vehicleType`. Un swap real (id distinto) ya NO arrastra attrs. ADR-017 §5(d) cerrado, gate adversarial `wvv7pn1z0` sin crítico/alto nuevo.
>
> **El flip a fail-closed sigue PENDIENTE** (decisión del dueño, data-gated) — (d) es necesario pero NO suficiente: faltan (a) distinguir outage-de-fleet de legacy-sin-attrs en el resolver, (b) invalidar la cache del resolver al cambiar vehículo, (c) poblar los legacy, (d.1) soltar attrs cuando el ping degradado no trae `vehicleId` (no heredar por clase), (d.2) la ventana de cache de 20s. Detalle en ADR-017 §5.

---

## 2. Actores

1. **Pasajero** (RN, iOS+Android) — busca/reserva (programado) o pide ahora (on-demand).
2. **Conductor** (RN, Android; iOS fase 3) — publica viajes (programado) o recibe ofertas (on-demand). **Verificado** (KYC + docs + biometría).
3. **Familia** (web pública, sin login) — ve el viaje en vivo del pasajero, recibe alertas.
4. **Admin/Operador** (web, RBAC) — verifica conductores, modera, soporta.

---

## 3. Modos de viaje × pricing (la matriz central)

|                   | **FIJO**                                                                                                                         | **PUJA (nuevo)**                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **🗓️ PROGRAMADO** | Conductor publica viaje con precio/asiento (rango + tope cost-sharing). Pasajero reserva al precio publicado. _(BlaBlaCar puro)_ | Conductor publica con precio base "negociable"; el pasajero ofrece precio → conductor acepta/contraoferta. _(híbrido nuevo)_ |
| **⚡ AHORA**      | Sistema cotiza Moto/Auto (tarifa medida). Pasajero acepta. _(VEO actual)_                                                        | Pasajero nombra precio → conductores cercanos aceptan/pujan. _(inDrive; el feature `bidding` actual es la base)_             |

> **Decisión RATIFICADA (2026-06-26 · [ADR-017](../docs/adr/017-modelo-pricing-energia-tiers.md)):** el **carpooling es SOLO FIJO** — el conductor fija el precio del asiento DENTRO de un tope cost-sharing (server-side, anti-exageración), nunca el sistema (eso sería precio comercial = "lucro"). **PUJA queda solo para AHORA** (inDrive, F6). El nudo legal cost-sharing vs comercial se valida con legal PE/EC antes de prod.
>
> 📐 **El modelo COMPLETO de pricing/tiers/comisión del híbrido está en [ADR-017](../docs/adr/017-modelo-pricing-energia-tiers.md)** (⚠️ el modelo de **energía/combustible del PRICING fue REMOVIDO 2026-07** — la tarifa on-demand usa **un solo per-km all-in** en la tarifa base, ver ADR-017 header · tiers: Económico/Normal/**Premium** por segmento + XL por capacidad · tarifa base y comisión configurables por país · el carpooling usa su **costo de operación/km directo editable** en el cost-cap (ADR-017 §1.4) · peajes **dentro** del cost-cap del carpooling (ADR-017 §1.7) · OCR del combustible de la TIVe **para la ficha/economía del conductor, NO para el precio** (§1.8) · y el **orden de configuración del admin**, que va ANTES que la UI de las apps).

---

## 4. Capa de seguridad (transversal — el moat)

Aplica a AMBOS modos. **Ya construida** (reusar):

- **Pánico:** automático invisible (triple botón volumen, sin UI) + manual (SOS rojo fullscreen). Mensaje firmado HMAC.
- **Cámara de cabina en vivo** (LiveKit) durante el viaje + indicador "REC".
- **Gate biométrico por turno** (liveness + match, 3 fallos = bloqueo 1h, sin bypass).
- **Familia-share:** enlace firmado que caduca al terminar el viaje.
- **Modo niño:** código que se exige para cambiar destino; nunca visible al conductor.
- **Contactos de confianza:** hasta 3, verificados por OTP.
- **KYC liveness** + **Verified Profile** (ID/email/teléfono + SOAT/licencia/tarjeta — el onboarding del conductor recién endurecido).

> ⚠️ **Enforcement — el KYC no gatea igual a los dos lados (ADR-018, IMPLEMENTADO):**
> · **CONDUCTOR = gate DURO**: KYC + biometría + docs son condición para operar (sin bypass). Éste es el moat real.
> · **PASAJERO = badge PROGRESIVO, NO muro**: la verificación del pasajero es **opcional** y otorga un **badge de confianza** ("Pasajero verificado", visible como filtro/StatusPill en búsqueda/carpooling); el estado inicial es `UNVERIFIED` y **NO** bloquea pedir un viaje on-demand. Se retiró el `assertKycVerified()` pre-viaje (modelo Uber/BlaBlaCar/inDrive: baja fricción de adquisición del lado demanda). Verified Profile del pasajero = badge, no gate.
> (Divergencia specs↔docs #1, reconciliada 2026-07-02 — manda ADR-018.)

---

## 5. Multipaís (Perú → Ecuador)

El design lo trae desde el splash (selección país+moneda). VEO necesita una **capa de localización**:

- **Moneda/locale:** S/ (es-PE) · USD (es-EC).
- **Documentos por país:** Perú = DNI/TIVe/SOAT (parsers ya construidos); Ecuador = cédula + docs propios (parsers NUEVOS).
- **Rails de pago:** Yape/Plin (Perú) ; rails Ecuador (a definir).
- **Regulación:** cost-sharing (carpooling) vs comercial (on-demand) difiere por país — mapear antes de lanzar.

---

## 6. Flujo detallado — PASAJERO

### 6.1 Onboarding/Auth _(reusa lo de VEO + el patrón del design)_

`Splash → [País+Moneda] → Bienvenida (elegí Programado/Ahora) → Auth teléfono+OTP → CompleteProfile → Main`

- Pantallas design: 0-21 (signup), 143-146 (foto+verif), 189-196 (login/forgot-password).
- VEO reusa: `SplashScreen`, `AuthScreen` (OTP), `CompleteProfileScreen`, `BiometricLock`.
- **Nuevo:** selector de país+moneda (multipaís).

### 6.2 PROGRAMADO — Buscar

`Home búsqueda → (autocompletado origen/destino) → (fecha 📅) → (#asientos) → Resultados → Filtros`

- Design: 22-41, 166-167, 182. Resultados con tabs (Carpool/Bus si aplica), cards (hora, duración, ruta, **precio fijo**, conductor★ verificado, amenities), Filter (orden, precio, pickup, amenities, Instant Booking, Verified Profile).
- **Nuevo (no existe en VEO):** búsqueda **por ruta+fecha+#asientos** (hoy VEO busca origen/destino para on-demand inmediato); lista de **viajes publicados**; filtros.

### 6.3 PROGRAMADO — Detalle del viaje

- Design: 42-43, 53-54, 109-110. Timeline (origen/pickup→stopovers→destino), precio/asiento, **card conductor verificado** (rating, Verified Profile, "Never cancels"), reglas (fumar/mascotas/máx 2 atrás), modelo de auto, mapa de pickup, CTA "Reservar" / "Contactar".
- **Nuevo.**

### 6.4 PROGRAMADO — Reservar + pagar

- Design: 44-56, 65-68, 106-108, 111-116.
- **FIJO:** "Revisá tu reserva" → mensaje de intro (plantillas) → método de pago → **cobro SOLO si el conductor aprueba** → **Esperando aprobación ⏳** (temporizado) → Aprobado/Rechazado (£0 + hold liberado si rechaza).
- **Special request top-up** (68): ofrecer +X por pickup/equipaje → aprobación.
- Cancelación: motivo (lista + texto) + **política de reembolso por tiers** (antelación).
- **Nuevo:** booking lifecycle + cobro diferido con hold + política de reembolso. (Reusa el `payment-service` + métodos Yape/Plin.)

### 6.5 Viaje en vivo _(reusa VEO + seguridad)_

- `TripActiveScreen` ya existe: mapa live, ETA, chat, **SOS**, **cámara REC**, **familia-share**, cambiar destino, cancelar. Pánico auto invisible armado.
- **Adaptar:** soportar viaje **multi-pasajero** (varios bookings en un viaje publicado) en la vista.

### 6.6 Pago final + Rating _(reusa VEO)_

- `PaymentScreen` (Yape/Plin/cash, propina, cargo idempotente) + `RatingScreen` (estrellas + comentario). Design 47-56 confirma breakdown (monto al conductor + service fee).

### 6.7 Seguridad / Cuenta _(reusa VEO)_

- Panic, TrustedContacts, ChildMode, KycCamera, Profile, SavedPlaces, PaymentMethods, TripHistory. Design 57-64 (reviews/reporte), 134-160 (cuenta), 161-163 (notificaciones), 183-188 (cierre de cuenta).

---

## 7. Flujo detallado — CONDUCTOR

### 7.1 Onboarding _(reusa — recién endurecido)_

`Auth → Registro wizard (datos+DNI scan, vehículo+tarjeta scan, licencia+SOAT scan, KYC biométrico) → en revisión → aprobado`

- Ya construido + calibrado esta sesión (OCR de docs, IDOR, biometría). **Verified Profile = el diferenciador vs BlaBlaCar (pares sin verificar).**

### 7.2 PROGRAMADO — Publicar viaje _(NUEVO — el corazón del carpooling)_

Design 81-103, 117-128:

```
origen → destino → drop-off exacto (mapa, pin draggable) → ruta (opciones con peajes/km)
→ stopovers (sugeridos + agregar ciudad) → puntos exactos de stopover
→ fecha (calendario) → hora (wheel picker) → capacidad asientos (stepper + "máx 2 atrás")
→ modo de reserva: [Instant Booking] vs [Revisar cada solicitud]
→ PRICING FIJO: precio/asiento (stepper + rango recomendado verde/rojo + tope cost-sharing) + precio por tramo
→ ¿publicar viaje de vuelta? → comentario → PUBLICAR
→ gestión: "Editar publicación" (itinerario/ruta/precio/asientos/Boost/duplicar/cancelar)
→ recibe reservas → aprueba/rechaza → viaje
```

- **Todo NUEVO.** Es el primitivo que VEO no tiene.

### 7.3 AHORA — Turno + ofertas _(reusa VEO)_

`Turno (🔴 gate biométrico) → en línea → le LLEGA viaje (oferta 12s, datos del pasajero OCULTOS) → acepta/puja → TripActive`

- Ya construido (`DashboardScreen`, `TripIncomingScreen`, `bidding`).

### 7.4 Ganancias / Payout

- `EarningsScreen` existe. **Nuevo:** payout del conductor (cuenta bancaria/billetera) — design 177-178.

---

## 8. Máquinas de estado

### 8.1 PROGRAMADO (carpooling)

**Viaje publicado:** `BORRADOR → PUBLICADO → (con reservas) PARCIALMENTE_RESERVADO → LLENO → EN_RUTA → COMPLETADO / CANCELADO`
**Booking (por asiento/pasajero, N por viaje):** `SOLICITADO → PENDIENTE_APROBACIÓN → APROBADO / RECHAZADO → CONFIRMADO(pagado) → EN_RUTA → COMPLETADO / CANCELADO(+reembolso por tier)`

- Instant Booking salta PENDIENTE_APROBACIÓN. Cobro diferido (hold) hasta aprobación.

> 📐 **Modelo técnico del cimiento → `docs/adr/014`.** F0/F1 viven en un servicio NUEVO, **`booking-service`**
> (no se extiende trip-service), dueño de `PublishedTrip` + `Booking`, con estas dos máquinas como enums tipados
>
> - `assertTransition`. **Corrección consciente al ADR-014:** el cobro NO es hold→charge sino **charge-on-approval
>   SIN hold** — payment-service no tiene HOLD y Yape/Plin (push instantáneo) tampoco; se valida el método al
>   reservar + reintento + estado DEBT como mitigación. El detalle está en el ADR.

### 8.2 PUJA (overlay — NUEVO, no está en el design)

`OFERTA_PASAJERO → [CONTRAOFERTA_CONDUCTOR ↔ ]* → ACEPTADA / RECHAZADA / EXPIRADA → (entra a la máquina del modo)`

- Base más cercana en el design: el "special request top-up" (stepper de oferta + envío para aprobación). Generalizar a bidireccional + contraoferta + expiración.

### 8.3 AHORA (dispatch) _(ya existe)_

`REQUESTED → ASSIGNED → ACCEPTED → IN_PROGRESS → COMPLETED / CANCELLED`

---

## 9. Modelo de datos (lo nuevo, backend)

> **Resuelto + construido (2026-06-25):** la duda "trip-service extendido o carpool-service nuevo" quedó decidida e implementada: **servicio nuevo `booking-service`** (no extiende trip-service). `PublishedTrip` y `Booking` ya existen con sus máquinas tipadas; ver `services/booking-service/prisma/` para el modelo real.

Entidades del carpooling:

- **PublishedTrip** _(✅ construido)_: driverId, vehicleId, origen, destino, stopovers[], fecha/hora, asientosTotales, asientosDisponibles, pricingMode(FIJO|PUJA), precioBase/precioPorTramo, modoReserva(INSTANT|REVIEW), reglas, estado, país/moneda.
- **Booking** _(✅ construido)_: publishedTripId, passengerId, asientos, pickup/dropoff (puede ser stopover), precioAcordado, estado, pago(**charge-on-approval sin hold**), mensajeIntro, método de pago elegido al reservar.
- **Bid** (si PUJA) _(⬜ pendiente — F6)_: bookingId/tripId, oferta, contraofertas[], estado.
- Reusa: `Trip` (on-demand), `Payment`, `Driver`, `Vehicle`, `Rating`.

---

## 10. Reusar vs CONSTRUIR

> **Actualización 2026-06-25:** lo que era "el gap" del **Backend** ya está en gran parte CONSTRUIDO en `booking-service` (F0 + backend de F3). El gap real hoy es la **UI de las apps** (pasajero/conductor) y el cableado en el dev-stack. La columna "CONSTRUIR" abajo marca **[backend ✅]** lo que ya existe server-side.

| Capa          | Reusa (ya está)                                                                | CONSTRUIR (el gap)                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pasajero**  | auth/OTP, perfil, mapas, pago (Yape/Plin), rating, chat, **toda la seguridad** | búsqueda ruta+fecha · resultados+filtros · detalle viaje publicado · reserva+espera-aprobación · special-request — **UI mobile PENDIENTE** (el backend de búsqueda/reserva ya existe en booking-service) |
| **Conductor** | onboarding+KYC+docs (endurecido), turno, viaje en vivo, ganancias              | **publicar viaje** (ruta/stopovers/asientos/pricing) · gestionar publicación · aprobar/rechazar reservas · payout — **UI mobile PENDIENTE** (aprobar/rechazar ya existe en backend)                      |
| **Backend**   | trip/dispatch/payment/identity/fleet/biometric                                 | **PublishedTrip + Booking multi-asiento [backend ✅]** · booking lifecycle [backend ✅] · pricing FIJO(rango+tope) [backend ✅] · **PUJA pendiente** · payout conductor pendiente                        |
| **Pricing**   | tarifa on-demand                                                               | carril FIJO (rango+tope cost-sharing) **[backend ✅: `cost-cap`]** · **carril PUJA bidireccional (nuevo, pendiente)**                                                                                    |
| **Multipaís** | i18n base                                                                      | país+moneda · parsers docs por país (cédula EC) · rails de pago por país                                                                                                                                 |

---

## 11. 🚦 PLAN DE ARRANQUE POR FASES (por dónde empezamos — para que CONECTE)

> **Principio:** un marketplace bootstrappea **OFERTA primero** (sin viajes publicados, buscar está vacío). Y se construye la **cadena end-to-end de UN carril (PROGRAMADO + FIJO + Perú)** antes de abrir más carriles. Cada fase deja algo **verificable y conectado** con la anterior.

> **Estado por fase (2026-06-25):** **F0 backend ✅** · **F1/F2 backend ✅ (endpoints en booking-service), UI mobile ⬜** · **F3 backend ✅ COMPLETO (F3a/b/c), UI mobile ⬜**. El cimiento server-side de la cadena PROGRAMADO+FIJO+Perú está construido en `booking-service`; lo que falta para que el marketplace sea usable es la **UI de las apps** y cablear el servicio en el dev-stack.

| Fase                                              | Qué construye                                                                                                                                                             | Con qué CONECTA                                   | Entregable verificable                                                                                           | Estado                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F0 · Cimiento de datos**                        | `PublishedTrip` + `Booking` + máquina de estados (§8.1) en **`booking-service`** (servicio nuevo, no trip-service). Migración. Contratos tipados.                         | Es la base; todo lo demás se enchufa acá.         | Crear/leer un viaje publicado + un booking por API (boot real, tests).                                           | **✅ backend** (`src/domain/`, migraciones 2026-06-22)                                                                                                     |
| **F1 · Publicar viaje (conductor)**               | Flujo publicar (§7.2): origen→destino→stopovers→fecha/hora→asientos→**precio FIJO** (rango+tope).                                                                         | F0 (crea un PublishedTrip real).                  | Un conductor publica → el viaje EXISTE en la DB con todos sus datos. **(Oferta creada.)**                        | **✅ backend** (`published-trips` + `cost-cap`) · **⬜ UI app**                                                                                            |
| **F2 · Buscar + ver (pasajero)**                  | Búsqueda ruta+fecha+#asientos (§6.2) → resultados+filtros → detalle viaje (§6.3).                                                                                         | F1 (muestra los viajes publicados).               | El pasajero ENCUENTRA el viaje que publicó el conductor. **(Oferta+demanda conectan.)**                          | **✅ backend** (índices H3 de búsqueda) · **⬜ UI app**                                                                                                    |
| **F3 · Reservar + aprobar + pagar**               | Request-to-book → conductor aprueba/rechaza → **cobro charge-on-approval SIN hold** (corrección al ADR-014; payment/Yape/Plin no tienen HOLD) → confirmado (§6.4 + §8.1). | F1+F2 (cierra la transacción).                    | Reserva extremo a extremo: publicar→buscar→reservar→aprobar→pagar→confirmado. **(El marketplace TRANSACCIONA.)** | **✅ backend COMPLETO** (F3a borde de pago + gate deuda, F3b aprobar/rechazar + CHARGE, F3c seat-lock atómico + consumer payment + refund) · **⬜ UI app** |
| **F4 · Viaje + seguridad**                        | Reusar `TripActive` + seguridad (pánico/cámara/familia/modo niño) sobre el viaje carpooling; soportar **multi-pasajero**.                                                 | F3 (el booking confirmado arranca el viaje).      | El viaje corre con SOS/cámara/familia. **(El diferenciador se aplica.)**                                         |
| **F5 · Ratings + payout + cancelación/reembolso** | Rating post-viaje (reusa), payout conductor, política de reembolso por tiers.                                                                                             | F3+F4 (cierra el ciclo monetario y de confianza). | Ciclo completo: viaje→pago→rating→payout; cancelar con reembolso.                                                |
| **F6 · Carril PUJA (inDrive)**                    | Diseñar+construir el overlay de puja bidireccional (§8.2) — NO está en el design.                                                                                         | F3 (carril alternativo al FIJO).                  | Pasajero ofrece precio → conductor acepta/contraoferta → reserva.                                                |
| **F7 · Modo AHORA unificado**                     | Integrar el on-demand (ya construido) en la UX unificada (tabs Programado/Ahora).                                                                                         | Reusa dispatch+bidding existentes.                | Una sola app con los 2 modos.                                                                                    |
| **F8 · Multipaís (Ecuador)**                      | Capa país+moneda + parsers docs EC (cédula) + rails de pago EC.                                                                                                           | Transversal, sobre todo lo anterior.              | VEO opera en Ecuador.                                                                                            |

### 👉 POR DÓNDE SEGUIMOS (actualizado 2026-06-26 · orden por DEPENDENCIA, [ADR-017](../docs/adr/017-modelo-pricing-energia-tiers.md))

El **cimiento backend del carpooling ya está** (F0 + backend de F1/F2/F3). Pero el orden NO es "directo a la UI": **el ADMIN-WEB (la configuración) va PRIMERO** — las apps CONSUMEN esa config, y sin un cimiento coherente la UI se construye sobre arena. El orden real:

0. **Alinear los planos** ([ADR-017](../docs/adr/017-modelo-pricing-energia-tiers.md) + este doc) con las decisiones de pricing/energía/tiers. _(en curso)_
1. **Cablear `booking-service` en el dev-stack** — enabler: hoy no se levanta con el orquestador; sin esto no hay e2e local.
2. **Cimiento de configuración del admin (la ESPINA, en orden de dependencia)** — catálogo de modelos → ofertas/clases (incl. **Premium** + foto) → tarifa base por país (con el per-km all-in) → costo/km del carpooling (directo, cost-cap del carpooling) → modo → comisión por país/modo. _(El eslabón `energía →` inicial se removió 2026-07 — el pricing por energía fue eliminado, ADR-017 header.)_ Acá se arreglan las 3 incoherencias de Finanzas + la legibilidad de Flotas. Vocabulario canónico de toda esta cadena: §1.5. **(Es el A: sin esto, las apps no tienen de dónde leer.)**
3. **F1 UI conductor** — publicar viaje (ruta→stopovers→fecha/hora→asientos→precio FIJO) contra `published-trips`.
4. **F2 UI pasajero** — búsqueda ruta+fecha+#asientos → resultados+filtros → detalle, contra la búsqueda H3.
5. **F3 UI** — reservar (pasajero) + aprobar/rechazar (conductor); el backend ya está. Apenas la UI se enchufa, el marketplace TRANSACCIONA.

_(Nota histórica: el plan original arrancaba en F0+F1 como cimiento de DATOS; eso ya se construyó server-side. El gap se movió del backend a (a) la **configuración del admin** y (b) la **presentación** — en ese orden.)_

> 📐 **El modelo técnico de F0/F1 — `booking-service` (servicio nuevo, puerto REST 3016 / gRPC 50054),
> `PublishedTrip`/`Booking` con enums tipados, eventos por outbox, y el cobro charge-on-approval (sin hold) —
> está cerrado en [`docs/adr/014`](../docs/adr/014-modelo-carpooling-booking-service.md).** La duda de §9
> ("trip-service extendido o carpool-service") queda resuelta ahí: servicio aislado, reusa el patrón de
> trip-service, no su código.

**Todo con `/abordar` por lotes** (explore→spec→design→tasks→apply→verify), gates `trazar`+`auditar-core` por lote, reusando la seguridad y el onboarding ya construidos.

---

## Anexo A · Mapeo screenshot → flujo (design BlaBlaCar 0-196)

| Flujo                                                                | Screenshots                    |
| -------------------------------------------------------------------- | ------------------------------ |
| Onboarding/Auth (signup, país+moneda, OTP)                           | 0-21                           |
| Login / forgot-password / set-password                               | 189-196                        |
| Foto de perfil + verificación email                                  | 143-147                        |
| Búsqueda (home, autocompletado, fecha, asientos)                     | 22-31, 166-167, 182            |
| Resultados + filtros (tabs Carpool/Bus)                              | 32-41                          |
| Detalle viaje carpool (+ mapas pickup)                               | 42-43, 53-54, 109-110          |
| Detalle viaje bus (timeline multi-tramo, amenities)                  | 69-71, 80                      |
| Reserva + mensaje intro + esperando aprobación                       | 44-46, 49-50, 106-108          |
| Pago (método, breakdown, tarjeta)                                    | 47-48, 51-52, 55-56            |
| **Special request top-up** (lo más cercano a oferta)                 | 68                             |
| Cancelación + política de reembolso                                  | 111-116                        |
| Bus checkout (webview: pasajeros→pago→QR)                            | 72-79                          |
| **Publicar viaje** (origen→...→precio FIJO)                          | 81-103                         |
| Gestionar publicación (Edit / stopovers / precio / Boost / cancelar) | 117-128                        |
| Perfil propio / público / reviews / reporte                          | 21, 57-64, 135-138, 171, 192   |
| Cuenta (settings, vehículo, dark mode, cierre)                       | 134, 139-160, 164-165, 183-188 |
| Notificaciones (push/email/SMS)                                      | 161-163                        |
| Mensajería / Inbox                                                   | 65-67, 131-133, 170            |
| Your rides / Archived                                                | 50, 104-105, 129-130, 168-169  |
| Payout conductor + métodos de pago pasajero                          | 177-181                        |

> **Nota pricing en el anexo:** TODO el design es FIJO. El carril PUJA (F6) se diseña aparte (no hay referencia visual en BlaBlaCar).
> </content>
