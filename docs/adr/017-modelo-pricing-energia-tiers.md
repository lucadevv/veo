# ADR 017 — Modelo de pricing, energía y tiers del marketplace híbrido

> Estado: **ACEPTADO** (Producto/pricing · **ADR sin código todavía** — define el modelo que las fases de
> construcción del híbrido implementan; es el NORTE que `VEO_MODELO_HIBRIDO`, `ADR-013` y `ADR-015`
> referencian). Cierra la **incoherencia de fondo**: el panel de Finanzas del admin se construyó para el
> mundo **on-demand** (tarifa medida + puja + comisión única global) y NO tiene superficie para el
> **carpooling** ni un **orden de configuración** coherente; además el precio NO matchea la energía real del
> vehículo y falta el tier **Premium**. Este ADR fija el modelo financiero/operativo del híbrido **antes** de
> tocar la UI de las apps (regla: el admin es el cimiento que las apps consumen).

> 📖 **Vocabulario canónico de la cadena de match** (los términos Clase/Ficha/Oferta · los DOS gates —
> operabilidad vs elegibilidad de oferta · el **desacople** del tier-gate que lee el ping en vez de la ficha):
> [`VEO_MODELO_HIBRIDO §1.5`](../../specs/VEO_MODELO_HIBRIDO.md), que consolida el §1.9 (DAG de config) y el §5
> (la cadena) de ESTE ADR en una sola tabla de referencia.

> 🔴 **SUPERSEDED IN PART (2026-07):** el modelo de **energía/combustible del pricing** fue **REMOVIDO** — la
> tarifa on-demand usa **un solo per-km all-in** (fórmula canónica Uber:
> `tarifa FIJA = max( round((base + perKm·km + perMin·min) × multiplier × surge), minFare ) [+ fee niño]`).
> Se borró el catálogo de energía (`EnergyCatalog`), el recargo de combustible (`FuelSurcharge`), el flip
> `PRICING_ENERGY_MODEL_ENABLED`, `deriveFuelPerKmCents`, `calculateOfferingFare` y el shadow-compare. **SIGUEN
> vigentes:** el multiplier/tiers, la tarifa base, puja/fijo, la comisión y el cost-cap del carpooling. El
> **`EnergySource`/eficiencia de la ficha del vehículo (§1.8)** NO era pricing — es economía del conductor / OCR
> de la TIVe — y **sigue**. Las secciones marcadas *OBSOLETO* abajo se conservan como registro histórico.

---

## 0. Contexto y problema

VEO es un **marketplace de movilidad segura híbrido**: 2 modos (**PROGRAMADO**/carpooling × **AHORA**/on-demand)
× pricing (**FIJO** × **PUJA**), multipaís PE→EC (ver `specs/VEO_MODELO_HIBRIDO.md`). El backend del
carpooling (`booking-service`, F0-F3) ya existe; lo que falta para arrancar el híbrido es el **cimiento de
configuración del admin** y la UI de las apps.

Evidencia nivel-1 (working tree, verificado 2026-06-26) de las incoherencias que este ADR resuelve:

- **El precio NO usa la energía real del vehículo.** `services/trip-service/src/trips/trips.service.ts`
  (`resolveEnergyPerKmCents`) deriva el costo del combustible de `offering.referenceEnergySourceId`/
  `referenceEfficiency` (por CLASE), NO del vehículo asignado. Un eléctrico en la oferta MOTO (ref
  `GASOLINE_95@40km/L`, `offerings.ts:155`) se cotiza como gasolina. **No hay match vehículo↔energía↔precio.**
- **La elegibilidad de oferta NO mira la energía.** `offerings.ts:332` (`vehicleMeetsRequirements`) gatea por
  `minSeats`/`minSegment`/`maxAgeYears`/`certifications` — nunca por `energySource`.
- **Falta el tier PREMIUM.** El segmento existe (`enums:110` `VehicleSegment {ECONOMY,MID,PREMIUM}` + rank
  `:118`), pero NINGUNA oferta lo usa: hay `VEO_ECONOMICO` (cualquier auto), `VEO_CONFORT` (`minSegment: MID`,
  `offerings.ts:191`) y `VEO_XL` (`minSeats: 6`, `:207`) — **no hay oferta de calidad PREMIUM**.
- **La tarifa base es código, no admin.** `services/trip-service/src/trips/domain/fare.ts:16-20` hardcodea
  `BASE_FARE_CENTS`/`PER_KM_CENTS`/`PER_MIN_CENTS`. No es configurable por país.
- **La comisión es una sola, global, por env.** `services/payment-service/src/config/env.schema.ts`
  `COMMISSION_RATE` default `0.2`, aplicada a on-demand Y carpooling sin diferenciar (ADR-015).
- **Dos "costo por km" desconectados.** On-demand deriva el per-km de la energía; el carpooling usa
  `costPerKmCents` (env por país) en su tope (`services/booking-service/src/domain/cost-cap.ts:57`).
- **El combustible real del vehículo se cura a mano, no del documento.** El OCR de la tarjeta de propiedad
  (TIVe) `apps/driver/src/features/documents/domain/ocr/parse-property-card.ts` extrae placa/marca/modelo/año/
  categoría MTC — **NO el combustible**, aunque la TIVe lo trae impreso. Hoy lo asigna el operador al aprobar
  el modelo (`services/fleet-service/src/vehicle-models/vehicle-models.service.ts:276`).
- **No hay orden de configuración.** Cada panel de Finanzas (energía/catálogo/pricing) es independiente y
  degrada a default en silencio; el operador debe adivinar las dependencias.

---

## 1. Decisión

### 1.1 Energía: UN precio por TIPO, class-reference, sin octanaje · 3 TIPOS de plataforma
> ⛔ **OBSOLETO (2026-07):** el pricing por energía/combustible fue REMOVIDO. La tarifa on-demand ya NO deriva
> el costo de la energía — usa un solo per-km all-in (ver bloque SUPERSEDED del header). El `EnergySource` de la
> **ficha del vehículo** (§1.8) NO es pricing y sobrevive. El texto abajo queda como registro histórico.

- El admin configura **un precio por TIPO de energía de PLATAFORMA**: **gasolina (referencia 90, la común)**,
  **diésel**, **eléctrico**. Son **3 tipos** (decisión del dueño 2026-06-27). Se **elimina el octanaje**
  (84/95: no importa) y se **EXCLUYEN GNV y GLP** como tipos de plataforma.
- **Por qué GNV/GLP fuera:** el combustible REAL del vehículo (si el dueño convirtió su auto a GNV/GLP para
  ahorrar) es **su decisión privada y su margen** — la plataforma NO lo trackea ni lo referencia para pricing.
  El OCR de la TIVe los OMITE (degradación honesta); el operador no los configura. (Verificado: ninguna oferta
  referenciaba GNV — `offerings.ts`.)
- El precio del viaje es **por-CLASE-referencia** (cada oferta declara su energía y rendimiento de
  referencia entre los 3 tipos), **NUNCA por la energía real del vehículo asignado**.
- **Por qué (rechazo del per-vehicle pricing):** si el precio dependiera de la energía real, un eléctrico
  (combustible más barato) aceptaría carreras más bajas y le ganaría al de gasolina — distorsiona el mercado
  en puja, fijo y carpooling. El combustible real del conductor es **su economía privada** (su margen, su
  incentivo a invertir en eléctrico/GNV), **no** un factor de precio ni de elegibilidad.
- La **elegibilidad de oferta NO gatea por energía** (se mantiene por clase/segmento/asientos/año/cert).

### 1.2 Tiers de servicio: Económico / Normal / Premium (calidad) + XL (capacidad), ejes SEPARADOS — ✅ HECHO (F2.3)
> **Parámetros confirmados (dueño, 2026-06-27) · CONSTRUIDO** (offerings.ts: `VEO_PREMIUM` creado mult 1.8 +
> minSegment PREMIUM + maxAge 5; `VEO_CONFORT` renombrado "Normal" (i18n, id intacto); `VEO_ECONOMICO_EV`
> eliminado; XL queda como eje capacidad):

- **CALIDAD** = `VehicleSegment` (ECONOMY/MID/PREMIUM), curado por el operador en el **modelo**. Un vehículo
  sirve **su tier Y los de abajo** (rank: PREMIUM→los 3, MID→2, ECONOMY→1). Ya implementado (`offerings.ts:340`).
  - **Económico** = cualquier auto (sin requisito de segmento).
  - **Normal** (`VEO_CONFORT`, MID) = sedán segmento **MID, ≤ 8 años** (ya existe así).
  - **Premium** (`VEO_PREMIUM`, NUEVO) = segmento **PREMIUM, ≤ 5 años + verificación por FOTO de la unidad**.
    **Multiplier 1.8.**
- **La verificación por foto NO es trabajo nuevo:** la **foto del vehículo (`VEHICLE_PHOTO`) YA se captura en
  el onboarding y es REQUERIDA para aprobar** (verificado, fleet-service) — el operador ya la tiene al revisar;
  para Premium solo la mira y setea el segmento. Espeja Uber Black (el estado real de la unidad, no solo el modelo).
- **CAPACIDAD** = `VEO_XL` (`minSeats: 6`) es un **eje aparte**, NO un tier de calidad. Premium ≠ asientos.
- El panel de catálogo del admin **separa visualmente** calidad (segmento) de capacidad.
- **`VEO_ECONOMICO_EV` se DEPRECIA** como oferta separada: el eléctrico es un **tipo de energía**, no una clase
  de servicio para el pasajero. Un auto eléctrico sirve su clase por calidad/capacidad y gana más por su menor
  costo. *(Decisión abierta §4: una marca "verde premium" puede evaluarse a futuro.)*

### 1.3 Tarifa base CONFIGURABLE por el admin, POR PAÍS
- `base + per-km + per-min` deja de estar hardcodeada (`fare.ts:16-20`) y pasa a **configuración del admin por
  país** (PE/EC). Multipaís real necesita tarifas distintas por mercado.

### 1.4 Costo de OPERACIÓN por km — DIRECTO editable (carpooling) · ~~energía (on-demand)~~
> ⛔ **OBSOLETO EN PARTE (2026-07):** la mitad **on-demand** de esta sección (costo de COMBUSTIBLE/km derivado de
> la energía) fue REMOVIDA — el on-demand ahora usa el per-km all-in de la tarifa base (§1.3), sin derivación de
> energía. **La mitad carpooling SIGUE VIGENTE:** el `CostPerKmConfig` DIRECTO editable por país (costo de
> operación real, combustible+desgaste) que alimenta el cost-cap del carpooling no cambió.

> ⚠️ **CORREGIDO (2026-06-27, investigación BlaBlaCar/inDrive).** El "unificar en una derivación de energía"
> fue un error de interpretación: son conceptos DISTINTOS. El **on-demand** mantiene su costo de COMBUSTIBLE/km
> derivado de la energía (precio fuente ÷ rendimiento). El **carpooling** usa el **costo de OPERACIÓN real/km**
> (combustible + desgaste/depreciación, estilo "IRS mileage rate") que el **admin fija DIRECTO por país**
> (`CostPerKmConfig` en booking-service, ej. S/1.50/km) — NO derivado de la nafta (sería bajo e irreal). El
> tope del carpooling lee ese valor directo. (Implementado: F2.5-v2, commit `18145d7`.)

### 1.5 Modo de precio: PUJA/FIJO solo en on-demand; carpooling SIEMPRE FIJO
- El schedule puja/fijo por horario (ADR-011) aplica **solo al on-demand**. El **carpooling es siempre FIJO**
  (precio del conductor dentro del tope). Ratifica la decisión pendiente de `VEO_MODELO_HIBRIDO:51`.

### 1.6 Comisión por MODO — DOS modelos distintos (corregido)
> ⚠️ **CORREGIDO (2026-06-27, investigación BlaBlaCar/inDrive).** No es "una rate por modo": son DOS MODELOS:
> - **on-demand (inDrive):** la comisión se **DESCUENTA al conductor** (`driverNet = tarifa − comisión`).
> - **carpooling (BlaBlaCar):** la comisión es un **SERVICE FEE que paga el PASAJERO**, sumado ARRIBA de la
>   contribución; el conductor cobra el **100%** de su contribución de costo-compartido. El pasajero paga
>   `contribución + fee`; la plataforma se queda el fee.
>
> **El "nudo legal" DESAPARECE con el modelo correcto:** el fee del carpooling es del PASAJERO (servicio de la
> plataforma), NO lucro sobre el costo-compartido del conductor — así opera BlaBlaCar legalmente. Por eso el
> carpooling SÍ puede tener comisión > 0 sin problema. Ambas tasas **admin-editables** (NO 0% fijo). (F2.7-v2,
> commit `18145d7`.) Per-país diferido a F8 (hoy por-modo, PE).

### 1.7 Carpooling: conductor fija DENTRO del tope + rango recomendado · por-asiento fijo · peajes EN el costo
- El conductor **ingresa** el precio del asiento, **acotado server-side** por el cost-cap
  `floor((km × costo/km) / asientosTotales)` (`cost-cap.ts:57`) — un precio por encima se **rechaza** (anti
  exageración, ya existe). **NO** lo calcula el sistema (eso lo volvería precio comercial = lucro).
- **Se agrega el rango recomendado (verde/rojo)** para guiar al conductor (está en el design, falta en código).
- **Por asiento FIJO:** el tope reparte el costo del trayecto entre **asientosTotales**; los asientos vacíos
  los **absorbe el conductor**, NO se sobre-cobra a los que van. Ya implementado.
- **Peajes EN el costo compartido (CORREGIDO 2026-06-27, investigación BlaBlaCar):** el peaje es **parte del
  costo del viaje** y va DENTRO de la fórmula del tope: `floor((km × costo/km + peaje) / asientosTotales)` —
  se suma al costo y se reparte entre asientos (así lo hace BlaBlaCar: `(combustible×dist + peaje) ÷ pasajeros`).
  El conductor **DECLARA** el peaje de su ruta (`PublishedTrip.tollsCents`), topado por el cost-cap (no infla).
  La decisión original "peajes aparte / fuera del cost-cap" fue ERRÓNEA. Auto-cálculo (TollGuru) = upgrade
  futuro. (F2.5-v2, commit `18145d7`.)

### 1.8 Combustible real del vehículo desde el OCR de la TIVe — ✅ HECHO (F2.2a)
- El parser de la tarjeta de propiedad **extrae el combustible** (`Combustible:`, la TIVe lo trae impreso) →
  el combustible real sale del **documento oficial**, no de la curación manual. Para la **economía del
  conductor / referencia del operador**, NO para el precio del pasajero (§1.1).
- Mapea solo a los **3 tipos de plataforma**: GASOLINA→GASOLINE_90, DIÉSEL/PETROLEO→DIESEL, ELÉCTRICO→ELECTRIC.
  **GNV y GLP → OMITIDOS** (combustible privado del conductor, §1.1) — el operador no los setea.
- Aterriza en `FleetDocument.extractedData` (contrato 3 capas sin romper `forbidNonWhitelisted`). Commit `378a7a6`.

### 1.9 Orden de configuración del admin (el DAG) + ADMIN PRIMERO
- La configuración del admin tiene un **orden de dependencias explícito** (para que exista B tiene que existir
  A), reflejado como un flujo guiado con degradación honesta ("X no configurado → usando default"):
  ```
  catálogo de modelos → ofertas/clases → tarifa base → costo/km → modo → comisión
  ```
  > *(El eslabón `energía →` inicial se ELIMINÓ 2026-07: el pricing por energía fue removido — ver header. La
  > tarifa base ya lleva el per-km all-in.)*
- **El admin-web se construye ANTES que la UI de las apps**: las apps (publicar/buscar/reservar) CONSUMEN esta
  configuración; sin un cimiento de config coherente, la UI se construye sobre arena.

---

## 2. Consecuencias (lo que implica construir)

- ~~**Catálogo de energía**: **3 tipos** (gasolina-90/diésel/eléctrico), un precio c/u; GNV/GLP fuera (§1.1). ✅ HECHO (F2.1a).~~
  ⛔ **OBSOLETO (2026-07):** el `EnergyCatalog` del pricing fue BORRADO (el on-demand usa per-km all-in). El `EnergySource` de la ficha del vehículo (§1.8, OCR de la TIVe) NO es esto y sigue.
- **Catálogo de ofertas**: crear `VEO_PREMIUM` + verificación por foto; separar calidad/capacidad en la UI;
  deprecar `VEO_ECONOMICO_EV`.
- **Tarifa base**: ✅ HECHO (F2.4, commit `f76a500`). Singleton GLOBAL `BaseFareConfig` (banderazo/km/min)
  editable por el admin (RBAC `pricing:manage` + step-up MFA + audit), seedeado 600/120/30 → CERO cambio de
  precio; threading a la fórmula (create + re-quotes + quote del public-bff) sin divergencia preview-vs-cobro.
  **Per-PAÍS diferido a F8** (multipaís): hoy GLOBAL, coherente con los configs hermanos (todos singleton).
- **Comisión por MODO**: ✅ HECHO (F2.7 → **corregido F2.7-v2**, commit `18145d7`). **on-demand** = comisión
  descontada al conductor; **carpooling** = **service fee SUMADO al pasajero** (conductor cobra el 100%, modelo
  BlaBlaCar — ver §1.6). **AMBAS admin-editables** (`CommissionConfig.onDemandRateBps` + `carpoolingFeeBps`,
  CAS+outbox, admin-bff finance+step-up+audit, panel). El "0% fijo legal-gated" anterior fue REEMPLAZADO: el
  modelo correcto (fee al pasajero) no tiene nudo legal. Per-país a F8.
- **Costo/km del carpooling**: ✅ HECHO (F2.5 → **corregido F2.5-v2**, commit `18145d7`). **DIRECTO editable por
  el admin por país** (`CostPerKmConfig`, seed PE=S/1.50/km = costo de operación real combustible+desgaste), NO
  derivado de energía (ver §1.4). El tope lo lee directo (degrada al env si cae). ~~El on-demand mantiene su modelo
  de energía (`deriveCostPerKmCents` en shared-types).~~ *(⛔ OBSOLETO 2026-07: el on-demand ya NO tiene modelo de
  energía — usa el per-km all-in de la tarifa base; ver header.)* **EC a F8.** DEUDA dueño: ajustar el valor real PE.
- **OCR TIVe**: agregar el campo combustible al parser `parse-property-card.ts` (+ tests con TIVe real).
- **Peajes**: ✅ HECHO (F2.5-v2, commit `18145d7`). El conductor **DECLARA** el peaje (`PublishedTrip.tollsCents`),
  va DENTRO del tope `floor((km×costo/km + peaje)/asientos)` (modelo BlaBlaCar, ver §1.7). Auto-cálculo (TollGuru)
  = upgrade futuro.
- **Orden de config**: el panel de Finanzas se reordena en el DAG §1.9 + arregla las 3 incoherencias (Finanzas
  on-demand vs carpooling, calidad vs capacidad, comisión opaca) + legibilidad de Flotas (nombres/placas, no
  UUIDs).

## 3. Alternativas consideradas (y por qué NO)

- **Pricing por energía real del vehículo** → rechazado: distorsiona el mercado (eléctrico/GNV subcotizan).
- **Gatear elegibilidad por energía** (eléctrico no entra a oferta de gasolina) → rechazado: misma distorsión;
  además innecesario si el precio es class-reference.
- **Sistema calcula el precio del carpooling** (no el conductor) → rechazado: lo vuelve precio comercial =
  "lucro", rompe el modelo cost-sharing legal. Se mantiene "conductor fija dentro del tope".
- ~~**Peajes dentro del cost-cap** → rechazado~~ → **REVERTIDO (2026-06-27, investigación BlaBlaCar):** el peaje
  SÍ va dentro del costo compartido y se reparte entre asientos (`(km×costo/km + peaje)÷asientos`) — es como
  funciona el cost-sharing real. La alternativa "peajes aparte" era la equivocada. Ver §1.7.
- **Comisión carpooling descontada al conductor** (modelo inDrive) → rechazado para carpooling: es lucro sobre el
  costo-compartido (ilegal). El carpooling usa el **service fee al pasajero** (modelo BlaBlaCar, §1.6).

## 4. Decisiones CERRADAS (2026-06-27) + abiertas

**Cerradas por el dueño:**
- **`VEO_ECONOMICO_EV` se DEPRECIA** — el eléctrico es solo un **tipo de energía**, no una oferta/clase para el
  pasajero. (Ya no es decisión abierta.)
- **Energía = 3 tipos** (gasolina-90/diésel/eléctrico); GNV/GLP fuera (§1.1).
- **Tiers**: Económico (any) · Normal MID ≤8a · Premium PREMIUM ≤5a + foto, multiplier 1.8; XL aparte (§1.2).

**Abiertas (no bloquean F2.3):**
- ⛔ **OBSOLETO (2026-07) — F2.1b, el FLIP** (`PRICING_ENERGY_MODEL_ENABLED`): **CANCELADO / DECISIÓN MUERTA.**
  El dueño resolvió REMOVER el modelo de energía del pricing en vez de flipearlo — no hay flip que activar. Se
  borraron el flag, el `EnergyCatalog`, el `FuelSurcharge`, `deriveFuelPerKmCents`, `calculateOfferingFare` y el
  shadow-compare. El análisis de impacto / boot-guard / resolver autoritativo de abajo quedan como registro
  histórico de un camino NO tomado.
  <br>~~**F2.1b — el FLIP** (`PRICING_ENERGY_MODEL_ENABLED`): activar B5 cambia precios reales.~~
  - ✅ **Análisis de impacto HECHO** (2026-06-26): grilla de rutas × ofertas × precios reales de energía, por las
    dos fórmulas (vieja = fuel global plegado y ×multiplier · nueva = energía pass-through por eficiencia). Resultado:
    el flip **BAJA precios ~1-3% típico** (saca el sobrecargo que el multiplicador metía sobre la energía); económico
    plano (es la referencia). **NUNCA flipear con el catálogo vacío** (−6% a −13% en rutas largas).
  - ✅ **Seguridad del flip HECHA** (F2.1b-safety): boot-guard fail-fast (flip ON + catálogo sin poblar → no arranca),
    guarda de completitud en el `replace()` del catálogo (PUT incompleto → `ValidationError`, exige TODA fuente
    referenciada incl. DIESEL de ambulancia/grúa), resolver autoritativo strict en los 3 caminos que cotizan tarifa
    firme (create + changeDestination + re-quote de parada) + CAS de estado → invariante "**nunca cobra de menos**".
    Gate adversarial (`auditar-core`): **5 ALTA cazadas y cerradas en 3 rondas** (re-quote sin energía, outage por PUT
    incompleto, outage de emergencia DIESEL, cobro-de-menos de combustible en re-quote, TOCTOU sin CAS).
  - ⬜ **El switch en sí** (decisión del dueño): poblar precios reales de energía (gasolina-90 + diésel) + elegir el
    nivel (aceptar −1-3% o subir energía para quedar revenue-neutral) + flipear el flag + deprecar B4 visualmente.
- ~~**Comisión sobre el bruto en cost-sharing**: validación legal pendiente~~ → **RESUELTO (2026-06-27,
  investigación BlaBlaCar).** El nudo legal se DISUELVE con el modelo correcto: el carpooling NO descuenta del
  conductor — cobra un **service fee al PASAJERO** (el conductor recupera el 100% de su costo, el fee es del
  pasajero). No es lucro sobre el costo-compartido. Comisión carpooling admin-editable, sin bloqueo legal (§1.6).
- **Tramo de retención 90d**, reporte DPO mensual: follow-ups de finanzas/compliance no bloqueantes.

## 5. La CADENA de match vehículo↔config — auditoría 2026-06-27

> Premisa del dueño: "todo es cadena". El vehículo del conductor (su `VehicleModelSpec`: segment/energySource/
> efficiency/seats) debe **hacer MATCH** con la config del admin (energía con precio, oferta/tier que lo acepte)
> ANTES de operar. La auditoría (`auditar-core`, scope flota+finanzas+dispatch) mapeó dónde el eslabón NO cierra.

**Falsos positivos refutados (NO tocar):** ~~la energía sin precio NO subsidia en silencio (`resolveAuthoritativeEnergy`
**lanza** `InvalidStateError`, fail-CLOSED)~~ *(⛔ OBSOLETO 2026-07: el resolver de energía del pricing se borró junto
con el modelo de energía — ya no hay energía que resolver en la tarifa; ver header)*; el costo/km NO degrada peligroso (la migración siembra PE=150/EC=50 + env=semilla);
el refund SÍ topa el over-refund (`payments.service.ts:1157`); los "N+1" de `expiry.sweeper` son lecturas batched en loops de
paginación. Las **certificaciones** de verticales (ambulancia/grúa) ya son fail-CLOSED — el gate de seguridad real funciona.

**Hechos (commits en `develop`):**
- **F1 — visibilidad (`9d5a0ce`)**: el panel de Flota era CIEGO a la ficha del match. Ahora `vehicleView` expone
  vehicleType/mtcCategory (del `Vehicle`) + segment/energySource/efficiency/seats (del `modelSpec`, enriquecidos
  BATCHED anti-N+1, degradan a null). Columna "Ficha técnica" con flag **"Sin ficha"** cuando falta — el caso que el
  dispatch fail-opea.
- **F2 — corrección (`2ca9d7e`)**: un `VehicleModelSpec` APROBADO con la ficha mal cargada quedaba congelado y
  contaminaba a TODOS sus vehículos (corrección = DB a mano). Ahora el operador lo **REABRE** (CAS APPROVED→PENDING_REVIEW,
  no borra la ficha vigente para no dejar a los vehículos sin ficha de golpe, audita) y lo re-aprueba corregido por el
  mismo formulario. Toggle Por revisar/Aprobados en la cola para llegar a los APPROVED. **Decisión del dueño: reabrir-a-PENDING,
  no editar in-place.**

**C2 — CERRADO + verificado por el gate adversarial (`594553e` + `3a6a5f5`):**
- **El carril PUJA ya enforça el TIER** como el FIXED. El `OfferBoard` transporta `category` (round-trip Redis JSON,
  campo en el tipo `OfferBoard`); `category` fluye `trip.bid_posted`/`trip.reassigning` (optional, compat N-2) → kafka
  consumer → board. El gate autoritativo `assertEligibleToOffer` deriva `findOffering(category)?.requires` y lo enforça
  en los **TRES** puntos: submit (`offer-board.service.ts:340`), accept (`:497`, fresh), listado (`boardMeetsRequires`)
  y broadcast (`:278`). Certs **FAIL-CLOSED**, attrs del vehículo **FAIL-OPEN** (paridad con el pool).
- **Verificación (`auditar-core` adversarial, refutador independiente):** el claim "C2 cierra la cadena" **sobrevivió**
  al refutador (*"no pude matar el claim: la cadena está cableada de punta a punta"*) — NO es un cierre falso de
  "solo-broadcast". Cero crítico/alto nuevo; los 4 falsos positivos (compat N-2, raw-persist, métrica) refutados como
  intencional+documentado+compensado. El único residual confirmado es MEDIA y ES el C1 de abajo (no una regresión de C2).
- **Simetría de observabilidad (`3a6a5f5`)**: el gate adversarial cazó que el branch fail-open que C2 agregó en el gate
  autoritativo NO se medía (solo el pool lo hacía). `dispatch_eligibility_fail_open_total` ahora lleva `source`:
  `pool` (prevalencia de flota, barrido amplio) vs `gate` (blast-radius del submit/accept de PUJA). Ambas superficies
  medidas, sin doble-contar. (La métrica `dispatch_puja_requires_skipped_total` se eliminó: el hueco que medía cerró.)

**Finanzas money-OUT (refund admin) — CERRADO / CONVERGIDO por loop-until-dry adversarial (`4395eb2` → `2dcb6b1`):**
- **Por qué primero, antes de C1:** el gate adversarial sobre la superficie operacional de finanzas cazó hallazgos de
  **mayor severidad** que C1 (sangrado de dinero por doble-refund + dead-end de step-up en prod + cap de multiplier ×100),
  así que la decisión del dueño fue **finanzas → C1**.
- **Cap de multiplier ×100** (`@Max(10)` en 5 capas: trip-service DTO, admin-bff DTO, api-client zod, catalog-panel UI) +
  **step-up MFA** movido a money-OUT (refund + payout vía `StepUpDialog`, ya no `ConfirmDialog`) + **footgun del Button**
  (`disabled || loading`, antes `disabled ?? loading` permitía doble-submit).
- **Idempotencia del refund admin** (lo central): el `Idempotency-Key` se liga a la **identidad de DINERO = (tripId, céntimos)**
  y NADA más (el motivo es texto libre, fuera del key). El server deriva `deriveAdminRefundDedupKey` (prefijo `admin-refund:`,
  namespace disjunto del `booking-cancel-refund:` system-initiated) → `Refund.dedupKey` UNIQUE PARCIAL → P2002 devuelve el
  refund existente si coinciden (paymentId, amountCents). El nonce del cliente **persiste en sessionStorage** atado a la firma
  y se limpia SOLO en éxito (un reintento de op no-confirmada reusa el key → dedup; dos parciales legítimos idénticos NO
  colapsan porque el 1ro hace SUCCESS → limpia el slot). Acceso a storage **tolerante** (try/catch que degrada al ref efímero,
  como `theme.tsx`): un storage bloqueado JAMÁS bloquea el reembolso.
- **Verificación (`auditar-core` adversarial, 3 rondas loop-until-dry):** severidad estrictamente decreciente —
  ronda 1 cazó 2 ALTA in-dialog (reason-en-firma + reset-on-open → doble-pago), ronda 2 cazó 1 ALTA cross-mount
  (useRef efímero → re-acuñaba key en remonte/refresh → doble money-OUT), ronda 3 cazó 1 MEDIA de disponibilidad
  (storage sin try/catch) + 1 BAJA (post-éxito dentro del try). La **ronda final NO cazó ningún bug nuevo accionable**:
  los confirmados son by-design (fail-open intencional, cross-mount cerrado, ref-espejo coherente) y el refutador MATÓ
  los 5 intentos de money-OUT nuevo. **Convergido en el cliente.**
- **Backstop server-side — CONSTRUIDO (`044244e` + `d1b4332`, decisión del dueño):** el residual del nonce de cliente (que
  SIEMPRE puede divergir: storage bloqueado + remonte, otra pestaña, otro dispositivo → dos keys para el mismo dinero →
  doble-pago acotado por el saldo) se cierra DURO en el server. Además del `dedupKey`, `payment-service` trata dos reembolsos
  del MISMO `(paymentId, céntimos)` creados dentro de `REFUND_IDEMPOTENCY_WINDOW_MINUTES` (env, default 15) como la MISMA
  operación → devuelve el existente, **independiente del key**. Race-safe: `pg_advisory_xact_lock(hashtext(paymentId))`
  serializa los refunds concurrentes del mismo pago (cierra el TOCTOU; test concurrente `Promise.all`). Solo el camino ADMIN
  (`claim.enforceWindowDedup`); el system-initiated conserva su `dedupKey` determinista. Gesto explícito **`forceNew`** (checkbox
  en el panel, propagado dialog→queries→admin-bff→payment-service) habilita un 2do parcial idéntico legítimo (el cliente además
  acuña un key fresco). `REJECTED` no cuenta en la ventana (no movió plata).
- **RBAC del refund — RESUELTO (`a996932` + `2dcb6b1`, decisión del dueño: refund = FINANZAS, no soporte):** `payment-service`
  alineado al spec `finance:refund` → `@Roles(FINANCE, ADMIN, SUPERADMIN)` (antes exigía SUPPORT_L1/L2 y OMITÍA FINANCE → un
  FINANCE pasaba el admin-bff pero el servicio lo rechazaba). **Dual-control de monto alto restaurado** bajo el modelo
  finanzas-only: un reembolso `> REFUND_L2_THRESHOLD_CENTS` (default recalibrado S/30 → S/300) exige autoridad ELEVADA
  (ADMIN/SUPERADMIN); un FINANCE queda topado al umbral. (Antes el gate de monto era el tier SUPPORT_L1/L2, que el RBAC dejó
  como código muerto → el dueño eligió restaurarlo con sentido en vez de quitarlo.) Compensa con step-up MFA + audit + tope por saldo.

**C1 — ENDURECIMIENTO previo al flip (CONSTRUIDO, `002d77f` + `767b0d0` + `084c936`, gate adversarial `wkrozhaf6`):**
Antes de flipear, dos lotes que sanean el cimiento (el audit del hilo C1 cazó que el flip no estaba listo no solo por falta de datos):
- **Lote 1 — anti-clobber del hot-index** (`hot-index/redis-hot-index.ts`): un ping SIN attrs (fleet 204/outage/legacy)
  SOBREESCRIBÍA via `SET` total del LUA los seats/segment/año BUENOS ya indexados → el gate de tier se auto-desarmaba
  AUNQUE la flota estuviera desplegada. Ahora `upsertLocation` preserva los attrs del ping previo cuando el ping los
  omite (mismo `vehicleType`); las certs NO se preservan (fail-closed = ausente-denegado, dirección segura). Espejado en
  el fake `InMemoryHotIndex` (paridad de contrato).
- **Lote 2 — instrumentación de prevalencia DECIDIBLE** (`dispatch/dispatch.metrics.ts`): el gate adversarial marcó que la
  métrica era no-normalizable (solo NUMERADOR). Agregado **DENOMINADOR** `dispatch_eligibility_tier_evaluations_total{source}`
  → `prevalencia = fail_open / tier_evaluations`, **invariante a la densidad por zona** (denominador con la misma
  granularidad que el numerador → una celda caliente infla ambos por igual). `offeringRestrictsByVehicleAttrs()` excluye las
  verticales certs-only del bump (no inflar el numerador con fugas inexistentes). `dispatch_eligibility_tier_unknown_total{reason=absent|unknown}`
  mide el tier irresoluble (solo en submit/accept, NO en el poll de `/bids/open` — si no, `absent` nunca tendería a 0 y
  engañaría el flip).

**Abierta — el FLIP de C1 (hardening previo CERRADO; el flip queda DIFERIDO por decisión del dueño, se validará sintético):**
- **C1 — fail-open de atributos ALL-OR-NOTHING** (`dispatch/driver-pool.ts` + `eligibility.gate.ts`): un vehículo
  cuyo ping no trae seats **Y** segment **Y** año (legacy sin `modelSpec`, o el resolver degradado por outage de fleet)
  pasa elegible para una oferta con requisitos sin verificar el tier. Es **deliberado** (rollout). El flip a fail-closed
  necesita: (a) distinguir "fleet caído" de "vehículo legacy sin attrs" en `active-vehicle-type.resolver` (hoy los
  conflagra → un outage de fleet se volvería un blackout de tiers), (b) cache-bust al cambiar el vehículo, (c) plan de
  población de los legacy, y **(d) ~~PREREQUISITO DURO del anti-clobber~~ ✅ HECHO (commit `73dfc9c`, develop): keyear el
  carry de attrs por IDENTIDAD de vehículo** (`vehicleId` en el ping firehose), NO por `vehicleType`. El vertical
  multi-servicio (fleet→resolver→publisher→evento→consumer→hot-index) se construyó sin tocar fleet ni la app (fleet ya
  devuelve `id` en `/drivers/vehicles/active`); el carry se llavea por `vehicleId` con fallback por compat a `vehicleType`.
  Verificado: tsc + 7/7 unit fake + 15/15 int Redis real (round-trip del LUA) + 228/228 suite dispatch; gate adversarial
  `wvv7pn1z0` (28 agentes) NO encontró crítico/alto nuevo (el desacople REDUCE el blast-radius). **(d) es NECESARIO pero
  NO SUFICIENTE — los dos residuales que `wvv7pn1z0` confirmó (d.1, d.2) están CERRADOS, más un tercer vector que el
  refutador de concurrencia destapó (cerrado by-design):**
  - **(d.1) — fallback por `vehicleType` ELIMINADO ✅ HECHO** (commit `7a7118b`, develop · `dispatch-service/src/hot-index/redis-hot-index.ts` +
    paridad in-memory): el carry es ESTRICTO por identidad — `sameVehicle = attrs?.vehicleId !== undefined && prev?.vehicleId === attrs.vehicleId`.
    Sin rama de compat por clase. Razón verificada: el `vehicleId` está ausente IFF los attrs también (misma rama del
    resolver degradado) → el fallback solo arrastraba attrs stale de un vehículo NO confirmable. El gate lo declaró SANO
    (paridad redis↔in-memory exacta). Antes (rama de compat) heredaba attrs en outage+swap-intra-clase; ahora SUELTA los
    attrs y deja que la política decida.
  - **(d.2) — invalidación de cache del resolver en swap ✅ HECHO, epoch-aware** (commit `1bebb22`, develop · `driver-bff/src/realtime/active-vehicle-type.resolver.ts`):
    `invalidate(userId)` borra la cache; cableado en `drivers.service.setActiveVehicle` tras el PATCH exitoso
    (`invalidate(identity.userId)`). El gate adversarial cazó un **ALTA TOCTOU read-then-invalidate** (un `resolve` en
    vuelo re-envenenaba la cache con el valor viejo DESPUÉS del `delete`, por todo el TTL de 20s). **Fix de causa raíz:**
    el `resolve` captura la GENERACIÓN (epoch por key) antes del await a fleet y solo cachea si la generación no cambió.
    Un refutador de concurrencia dedicado NO pudo romperlo; un test determinista reproduce la race (falla sin el fix).
  - **Vector 4 — residual del TOCTOU (lag de réplica) CERRADO by-design** (commit `a1f04c2`, develop · `fleet-service/src/vehicles/vehicles.service.ts:getActiveVehicle`):
    el refutador encontró que el epoch NO cubre "un `resolve` que arranca DESPUÉS del `invalidate` pero cuyo GET a fleet
    devuelve el vehículo viejo por lag de réplica". Hoy es teórico (fleet sin réplica, `DATABASE_URL_REPLICA` ausente →
    read=write), pero se cerró: `getActiveVehicle` lee el vehículo activo de `prisma.write` (primario), NO de `prisma.read`,
    garantizando read-your-writes del swap aunque se active una réplica.

  **DECISIÓN DEL DUEÑO (2026-06-30): CERRAR las landmines (d.1 + d.2 + vector 4), pero NO FLIPEAR todavía** a fail-closed.
  Motivo: las landmines son hardening neto igual; el flip se desacopla de la decisión de blast-radius (qué hacer en outage
  transitorio de fleet vs vehículo genuinamente sin ficha). VEO no está en prod → no hay dato de prevalencia que esperar; el
  flip se validará **sintético** cuando el dueño lo decida. Las métricas `source=pool|gate` + el denominador siguen dando el
  ratio limpio para calibrar el nivel.

  > **Residuales ABIERTOS (no son blockers del hardening, son del flip futuro):**
  > **(R1) BAJA — cache multi-instancia:** la cache del resolver es un `Map` in-process (per-réplica). `invalidate` solo
  > limpia la réplica que atendió el swap; si driver-bff escala a >1 réplica, otras sirven stale hasta su TTL de 20s.
  > **Inerte hoy** (single-replica). Cierre completo futuro = invalidación cross-instancia (pub/sub Redis).
  > **(R2) El FLIP a fail-closed sigue DIFERIDO** (decisión del dueño, arriba). Cuando se haga: recordar el transitorio de
  > ~1 ping post-swap (el caller en vuelo recibe el valor viejo UNA vez, no se cachea) — bounded por la cadencia del ping,
  > NO un defecto.

  > **Hallazgos transversales de `wvv7pn1z0` (PRE-EXISTENTES, fuera del desacople, en el tema "matchear antes del viaje"):**
  > **(1) ALTA — el pool FIXED no re-valida suspendido/online contra identity** (`dispatch/driver-pool.ts:50`): un conductor
  > SUSPENDIDO que sigue pingeando GPS permanece en el pool y acepta viajes FIXED. Asimetría: PUJA re-valida en
  > `EligibilityGate.assertEligibleToOffer`, FIXED no. Raíz: dispatch NO consume `driver.suspended` para purgar el hot-index.
  > **(2) ALTA — el sello server-authoritative del `vehicleType` se desarma en outage/204 de fleet** (`active-vehicle-type.resolver.ts:79`):
  > cae al `vehicleType` declarado por el cliente. Explotabilidad acotada (VehicleClass cerrado CAR|MOTO, el cliente no
  > fabrica attrs, hoy fail-open igual deja pasar), pero es decisión del dueño: ¿fail-closed en 204 o degradación honesta?
  > Ambos son **decisión del dueño** (seguridad/operabilidad) — no se auto-deciden.
