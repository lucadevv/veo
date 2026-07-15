# ADR 023 — Modelo de pricing por COEXISTENCIA (FIJO · PUJA · COST-SHARE)

> Estado: **RATIFICADO** (decisiones del dueño 2026-07-07). Fuente de verdad del **modelo de pricing** de VEO.
> **CONSOLIDA y RECONCILIA** los ADRs de pricing previos: refina 010 (puja) y 013 (catálogo), **SUPERSEDE la
> parte de franjas horarias** de 011, reconcilia el naming de 014 (carpooling) y hereda la remoción de energía
> de 017. Donde este ADR y uno previo difieran en el MODELO de pricing, **manda el 023**.
>
> 📖 Plan de implementación: [`specs/changes/pricing-taxonomy/`](../../specs/changes/pricing-taxonomy/) (proposal · design · tasks).

---

## 0. Contexto — VEO es un híbrido de 3 apps

VEO combina las mecánicas de precio de tres referentes del mercado. La pregunta que este ADR cierra: **¿CÓMO
conviven las tres?**

- **Uber** — precio FIJO computado por la plataforma (`base + per-km·km + per-min·min`), take-it-or-leave-it.
- **inDrive** — PUJA: la plataforma sugiere un precio; el pasajero ofrece; el conductor acepta o **contra-oferta**.
- **BlaBlaCar** — COST-SHARE: viaje compartido programado; el conductor fija el precio **≤ tope** (costo/km),
  dividido por asientos + un service fee al pasajero. **No-comercial** (escudo anti-lucro, Ley 29733).

Había dos maneras de combinarlas, y elegimos una a conciencia (ver §2).

---

## 1. Decisión — COEXISTENCIA de 3 modos PUROS, asignados POR SERVICIO

**Cada mecánica queda PURA y es un MODO (o producto) separado dentro de la misma plataforma. El admin asigna,
a mano, qué modo usa cada servicio. El pasajero elige un servicio → obtiene su modo.**

```
                        Una sola fórmula de distancia:
        tarifa = ( base + perKm·km + perMin·min ) × multiplicador      [piso: mínima]

   ┌────────────── el MODO decide qué SIGNIFICA ese número ──────────────┐
   │                                                                     │
 FIJO (Uber)              PUJA (inDrive)                COST-SHARE (BlaBlaCar)
 la fórmula = el precio   la fórmula = piso/sugerido    la fórmula = TOPE (cap)
 plataforma computa,      el pasajero ofrece ≥ piso;    el conductor pone ≤ cap,
 el pasajero toma/deja    el conductor acepta/contra    ÷ asientos + service fee
```

### 1.1 El modo es PER-SERVICE y MANUAL (palanca del admin)

- **Cada `ServiceOffering` tiene UN `mode`** (`FIXED` | `PUJA` | `COST_SHARE`), fijo, parte del catálogo.
- **Lo asigna el admin A MANO** desde el panel. Puede razonar sobre la demanda al decidir ("este servicio es
  de alta demanda → FIJO"), pero es una **asignación estática**: cambia SOLO si el admin entra y la cambia.
- **El sistema NUNCA flipea el modo solo** (ni por horario, ni por demanda en tiempo real). Eso **supersede** el
  motor de franjas de ADR 011 (ver §4).
- **`resolve-once-persist-forever` SOBREVIVE** (ADR 011 §1.2): el modo se congela en `Trip.dispatchMode` al
  crear el viaje y NO se re-resuelve durante su vida. Lo que cambia es DE DÓNDE se resuelve: de `offering.mode`
  (no de un schedule).

### 1.2 El pasajero elige el servicio → obtiene el modo

El admin no "flipea una ruta"; define, de una vez, el modo de cada servicio. El pasajero elige entre ellos:

**Ruta Lima Centro → Aeropuerto Jorge Chávez** (el mismo origen-destino, 3 servicios):

| El pasajero elige…       | Es el modo…          | Qué pasa                                                         |
| ------------------------ | -------------------- | ---------------------------------------------------------------- |
| **"Económico"**          | FIJO (Uber)          | S/ 35 fijo, toma o deja                                          |
| **"Ofertá tu precio"**   | PUJA (inDrive)       | ofrece S/25 → el conductor contra S/30 → cierran en S/28         |
| **"Viaje compartido"**   | COST-SHARE (BlaBlaCar) | el conductor publicó S/12/asiento (programado) — **otro producto** |

---

## 2. Por qué COEXISTENCIA y no "LICUADORA"

La alternativa (rechazada) era **mezclar los mecanismos de 2 apps en una experiencia** (surge de Uber DENTRO de
la puja; base comercial de Uber DENTRO del carpooling; puja DENTRO de Uber). La llamamos "licuadora". La
descartamos:

| Aspecto              | Coexistencia (elegido)                                        | Licuadora (rechazado)                                    |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| **Legal (Ley 29733)**| Cost-share PURO = sin lucro, escudo anti-lucro intacto       | Base comercial en el carpooling ROMPE el anti-lucro      |
| **Complejidad**      | Cada modo se explica solo. UX clara.                         | Mezclar mecanismos confunde y acopla                     |
| **Riesgo**           | Modos probados en el mercado. Bajo riesgo.                   | Pricing exótico = alto riesgo operativo                  |
| **Diferenciador VEO**| Seguridad (biometría/pánico/video) es el eje; pricing = herramienta | El pricing se vuelve el foco, no la seguridad     |

**Decisiones del dueño (2026-07-07):**

- **Modo = per-service, palanca MANUAL** (no per-viaje "Ahora/Ahorra"; no auto-flip por demanda).
- **Surge = AFUERA** del modelo (ver §5).
- **Híbrido "base+tiempo al carpooling" = RECHAZADO** (rompe el anti-lucro).
- **PUJA gana la contra-oferta del conductor** (inDrive real, ya en ADR 010 §9.2).

---

## 3. La fórmula (única) + params por servicio + los límites honestos

Una sola fórmula de distancia; cambian los **parámetros por servicio** (algunos en CERO) y el **modo**. Es
exactamente `calculateFirmFare` (`trip-service/domain/fare.ts`), money-critical, que **no cambia**.

| Servicio       | base           | perKm          | perMin           | mult | modo        | categoría (menú) |
| -------------- | -------------- | -------------- | ---------------- | ---- | ----------- | ---------------- |
| Moto/Económico | default        | default        | default          | 0.55–1.0 | FIXED o PUJA | RIDE          |
| Premium        | default        | default        | default          | 1.8  | FIXED o PUJA | RIDE           |
| Ambulancia     | default o mayor| ✅             | ✅               | 2.5 (emergencia) | FIXED | SPECIAL     |
| Grúa           | hook-up        | ✅             | **0**            | 1.0  | FIXED       | SPECIAL          |
| **Mecánico**   | call-out (S/50)| **0**          | **0** (labor aparte) | 1.0 | FIXED   | SPECIAL          |
| Carpooling     | 0              | costo/km país  | 0                | 1.0  | COST_SHARE  | CARPOOL (aparte) |

**Los DOS bordes honestos — la fórmula NO estira a todo** (asume `km` y `min` conocidos AL COTIZAR):

- **Mecánico = call-out plano.** Una VISITA no es un VIAJE: el cliente no viaja (`perKm=0`) y la **labor no se
  sabe al cotizar** (`perMin` de labor no existe aún). Se cotiza un **call-out plano** (`base`) upfront; la
  labor/repuestos se cobran **aparte**, tras el diagnóstico. NO es "la fórmula con ceros" — es un fee de visita.
- **Carpooling = producto propio.** Comparte la **cuenta de distancia** (costo/km) pero su **flujo** (publicado/
  programado + reservar asientos), sus **params** (costo/km-cap por país · asientos · service fee) y su
  **economía** (no-comercial: conductor 100 %, fee al pasajero) son suyos. Vive en **`booking-service`** (ADR
  014), no en el catálogo de viajes.

**La unificación es REAL para los viajes on-demand que TRANSPORTAN** (FIJO=Uber + PUJA=inDrive, una fórmula +
toggle; ambulancia/grúa entran con multiplicador). Mecánico y Carpooling son bordes que **no se fuerzan al
molde**. No hay "una fórmula para todo": hay una fórmula de viaje + dos bordes honestos.

---

## 4. Coexistencia ≠ 3 apps ≠ 3 microservicios por modo

**Una sola app / una arquitectura por DOMINIO.** El pasajero no sabe que hay 3 motores: solo ve que el precio se
comporta distinto según el servicio.

- **La frontera de servicios es por DOMINIO, no por modo de pricing** (regla del CLAUDE.md / ADR 002: DB-per-service).
  Los 17 servicios se parten por dominio (`trip`, `dispatch`, `payment`, `panic`, `booking`…), **jamás** en
  `fixed/` `auction/` `costshare/`.
- **FIJO y PUJA viven en `trip-service` como una ESTRATEGIA por modo** (el `DispatchModeRegistry` +
  `FixedDispatchStrategy`/`PujaDispatchStrategy` de ADR 013 §1.4 · la negociación de la puja la orquesta
  `dispatch-service`, ADR 010). El modo sale de `offering.mode`.
- **COST-SHARE vive en `booking-service`** (ADR 014) — el marketplace programado, su propio agregado y flujo.
- **La pureza NO necesita 3 servicios**: se logra con el patrón estrategia + el bounded context del carpooling.
  Coexistencia = **3 estrategias/productos puros**, no 3 microservicios clonados.

### 4.1 Qué SUPERSEDE de ADR 011 (franjas)

ADR 011 resolvía el modo con un **schedule horario** (`resolvePricingMode(zone, now)` → PUJA|FIXED por
franja). **Eso se elimina.** El modo ahora es `offering.mode` (per-service, manual). Lo que **sobrevive** de 011:
la regla de oro **resolve-once-persist-forever** (`Trip.dispatchMode` congelado) — solo cambia la FUENTE (la
oferta, no el schedule). Se borran: `PricingModeSchedule`, `resolveMode(schedule)`, `PricingModeRule`, el
`allowedModes ∩ schedule` de ADR 013 §1.3 (pasa a `offering.mode` directo).

---

## 5. Surge — AFUERA del modelo (decisión del dueño)

El surge se **remueve** del modelo de pricing. Razón: solo tenía sentido en FIJO (Uber); inDrive y BlaBlaCar no
surgean; y aplicado al **cap de cost-share** rompería el anti-lucro (inflar el tope = lucro). Estaba, además, a
medio construir (ningún admin lo configuraba). `calculateFirmFare` conserva su parámetro `surgeMultiplier` en
**1.0** (default) — no es config del admin. Esto supersede la "surge sugiere en la puja" de ADR 010 §9.5.

---

## 6. Reconciliación con los ADRs previos (mapa)

| ADR | Qué decía | Estado tras 023 |
| --- | --------- | --------------- |
| **010** (puja) | la puja COEXISTE con el fijo; contra-oferta del conductor; surge sugiere | ✅ vigente (coexistencia confirmada); ⚠️ el surge-sugiere se **remueve** (§5) |
| **011** (franjas) | el admin flipea el modo por HORARIO (schedule) | 🔴 **SUPERSEDED en la parte de schedule**: el modo es per-service MANUAL (§4.1). Sobrevive resolve-once-persist |
| **013** (catálogo) | `OfferingSpec.allowedModes` + `resolveOfferingMode(offering, schedule)` | ⚠️ `allowedModes` → **`mode`** (uno por oferta); + params opcionales `{baseFareCents?, perKmCents?, perMinCents?}`; + especiales (ambulancia/grúa/mecánico call-out) |
| **014** (carpooling) | `booking-service` aparte; `pricingMode = FIJO` (conductor fija ≤ cap) | ✅ producto aparte confirmado; ⚠️ **naming**: ese "FIJO del conductor dentro del cap" ES **COST-SHARE** en la taxonomía 023 (BlaBlaCar) — se distingue del FIJO=Uber (plataforma computa) |
| **017** (energía/tiers) | energía en el pricing + tiers | ✅ energía ya REMOVIDA (2026-07); tiers/multiplier/comisión/cost-cap vigentes |

> **Nota de naming (014 ↔ 023):** ADR 014 usa `PricingMode.FIJO` para el carpooling con el sentido "el conductor
> pone un precio FIJO por asiento (no negociado), acotado por el cost-cap". En la taxonomía de 023 ese mecanismo
> es **COST_SHARE** (el conductor fija ≤ tope, ÷ asientos, service fee, no-comercial). El **FIXED** de 023 es
> otra cosa: la plataforma COMPUTA el precio (Uber). Se recomienda, en el enum del carpooling, migrar el rótulo a
> `COST_SHARE` para no colisionar con el `FIXED`=Uber del on-demand.

---

## 7. Consecuencias

**Positivas:** modelo legalmente seguro (cost-share puro), operativamente simple (cada modo se explica solo),
diferenciador en SEGURIDAD (el pricing es herramienta probada, no el foco), y **escalable** (se agrega un modo
puro nuevo sin romper los existentes — 1 estrategia + 1 valor de enum, ADR 013 §1.4).

**Costos / lo que se difiere:** la migración `allowedModes → mode` + params por servicio + el naming del
carpooling (ver plan en `specs/changes/pricing-taxonomy/tasks.md`, Fases A/B). La palanca de mode-per-service ya
la soporta el catálogo (el admin edita el `mode`); no re-agrega el motor de franjas.

---

## 8. Referencias

- ADR 010 (puja · coexistencia) · ADR 011 (franjas — SUPERSEDED en schedule) · ADR 013 (catálogo de ofertas) ·
  ADR 014 (carpooling = booking-service) · ADR 017 (energía removida, tiers)
- Plan: `specs/changes/pricing-taxonomy/{proposal,design,tasks}.md`
- Investigación (fuentes): Uber (surge/fórmula), inDrive (recommended + bid + contra-oferta), BlaBlaCar
  (cost-share cap + service fee 11-20 % + conductor 100 %).
- Código: `trip-service/domain/fare.ts` (`calculateFirmFare`), `trip-service/dispatch-mode/` (estrategias),
  `booking-service/` (COST-SHARE), `shared-types/catalog/offerings.ts` (catálogo).

---

_Decisión: coexistencia de 3 modos puros (FIJO=Uber · PUJA=inDrive · COST-SHARE=BlaBlaCar), asignados por
servicio a mano por el admin (sin auto-flip), una fórmula de distancia parametrizada, con dos bordes honestos
(Mecánico call-out, Carpooling producto aparte). Surge afuera. Frontera por dominio, modo por estrategia.
Supersede las franjas de 011; reconcilia 010/013/014/017. Próximo: Fases A/B del plan pricing-taxonomy._
