# ADR 013 — Catálogo de ServiceOfferings (VehicleClass + política de pricing POR oferta)

> Estado: **PROPUESTO** (Lote P · diseño sin código). Fecha: 2026-06-11.
> Hace que agregar una oferta de servicio nueva (mototaxi, mecánico, ambulancia, confort, lo-que-venga)
> o un modo de precio nuevo sea **AGREGAR una entrada/clase**, no editar N archivos testeados.
> Refina (no reemplaza) ADR 010 (puja) y ADR 011 (switch PUJA↔FIJO por horario).
>
> ⚠️ **EXTENDIDO por [ADR-017](./017-modelo-pricing-energia-tiers.md) (2026-06-26):** el modelo de energía
> (un precio por tipo, sin octanaje, class-reference), el **tier PREMIUM** (que este catálogo aún NO tiene) +
> verificación por foto, la separación calidad(segmento)/capacidad(XL), la **tarifa base y comisión
> configurables por país**, el **costo/km unificado** y el **orden de configuración del admin** se definen en
> ADR-017. Donde este ADR y el 017 difieran (p.ej. el set de ofertas sin Premium, energía por octanaje), MANDA
> el 017.
>
> 📛 **Naming (mapping canónico de 3 capas — para no reintroducir la colisión de "Catálogo"):**
> · **código/servicio** = `ServiceOffering` / `OfferingId` (el término técnico, inmutable, este ADR)
> · **UI admin** = **"Ofertas de servicio"** (ruta `/finance/catalog`) — antes rotulada "Catálogo de ofertas"
> · **Flota** = **"Modelos"** (`VehicleModelSpec`) — es OTRO catálogo, no confundir.
> El label de producto es **"Ofertas de servicio"**; "Catálogo" queda solo como término técnico interno. Fuente única: `specs/VEO_MODELO_HIBRIDO.md §1.5` + `specs/VEO_SPEC_ADMIN.md §3.0`. (Divergencia specs↔docs #3, reconciliada 2026-07-02.)
>
> 🔵 **ALINEADO por [ADR-023](./023-modelo-pricing-coexistencia.md) (2026-07-07):** el `allowedModes` (+ la
> intersección `allowedModes ∩ schedule` de §1.3) se REEMPLAZA por **un solo `mode` por oferta** (`FIXED`|`PUJA`|
> `COST_SHARE`), asignado a mano por el admin (sin schedule). `OfferingPricingPolicy` gana overrides opcionales
> `{baseFareCents?, perKmCents?, perMinCents?}` (params por servicio: Mecánico perKm=0 **Y** perMin=0 = call-out
> plano; Grúa perMin=0). Los especiales (ambulancia/grúa/mecánico) son ofertas FIXED con sus params. Ver 023 §3.

---

## 0. Contexto y problema

La auditoría (Lote P · promover patrones) confirmó que los "ejes" de servicio crecen por **acumulación**:
cada tier nuevo (Ola 2B moto) se cableó editando media docena de archivos, y el próximo (ambulancia,
mecánico) repetiría el patrón multiplicado. Tres ejes concretos:

### Eje 1 — `vehicleType` (CAR|MOTO) definido en 6 lugares

El mismo par de literales vive copiado, sin fuente única:

| #   | Definición                                                            | Archivo                                                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `VehicleType` const (canónico)                                        | `packages/shared-types/src/enums/index.ts:64`                           |
| 2   | `mobileVehicleType = z.enum(['CAR','MOTO'])` (espejo wire deliberado) | `packages/api-client/src/mobile.ts:28`                                  |
| 3   | union inline `'CAR' \| 'MOTO'` en `RideCategory`                      | `services/bff/public-bff/src/maps/fare.ts:46`                           |
| 4   | `NearbyVehicleType = 'CAR' \| 'MOTO'`                                 | `apps/passenger/src/features/dispatch/domain/dispatchRepository.ts:8`   |
| 5   | `VehicleType = 'MOTO' \| 'CAR'`                                       | `apps/driver/src/features/registration/domain/entities/index.ts:41`     |
| 6   | `VehicleType` + `parseVehicleType`                                    | `apps/driver/src/features/shift/domain/value-objects/vehicle-type.ts:9` |

(+2 espejos Prisma legítimos: `trip-service/prisma/schema.prisma:79`, `fleet-service/prisma/schema.prisma:61` —
esos se quedan: Prisma no importa TS, el espejo DB↔shared-types es la convención del repo.)

Y en las apps hay **~9 ternarios `=== 'MOTO'`** para ícono/label/color (`VehicleIcon.tsx` ×2,
`RouteQuoteScreen.tsx:293,297`, `QuotingBody.tsx:329,332`, `TripHistoryRow.tsx:108`, `BidCard.tsx:16`,
`VehicleStatusCard.tsx:47`). Agregar AMBULANCE hoy = tocar los 6 puntos de definición + los 9 ternarios.

### Eje 2 — `category` hardcodeada en public-bff + el bug del multiplier

`RIDE_CATEGORIES` (`public-bff/src/maps/fare.ts:58-63`) define ids de dominio (`veo_moto`, `veo_economico`,
`veo_confort`, `veo_xl`), el mapeo category→vehicleType y el `multiplier`, todo en el BFF. La cadena real:

```
GET /maps/quote → options[] {id, name, vehicleType, priceCents(multiplier aplicado)}
   → la app elige y manda POST /trips {category, vehicleType, bidCents?}
   → trip-service PERSISTE category como string OPACO (trips.service.ts:324)
   → en FIXED la tarifa firme = calculateFare(ruta, surge, niño) SIN multiplier ni mínima por categoría
      (fixed-dispatch.strategy.ts:28-35 → domain/fare.ts)
```

**Bug confirmado:** en modo FIXED, `veo_confort` (×1.25) y `veo_xl` (×1.6) cobran la tarifa de
`veo_economico` (×1.0), y `veo_moto` cobra MÁS que su preview (×0.55, mínima S/3 vs S/5). El quote promete
un precio que `createTrip` no aplica. (En PUJA no afecta: el bid ES la tarifa.) El propio código lo declara
deuda: _"Si se modela tarifa por categoría a futuro, este es el punto donde alimentar calculateFare"_.

### Eje 3 — `PricingMode` global+temporal, sin dimensión de oferta

`resolveMode(schedule, zone, date)` (`trip-service/src/trips/domain/pricing-mode.ts:87`) resuelve PUJA|FIXED
por **horario global** (ADR 011 Tier 1). No recibe oferta/vehicleClass → es **imposible** "moto = puja y
ambulancia = fija" a la vez. Y una ambulancia NO debería negociar precio jamás, diga lo que diga el schedule.

**Lo que YA está bien (Lote S, no se re-litiga):** la VARIACIÓN de comportamiento por modo ya es Strategy:
`DispatchModeRegistry` + `PujaDispatchStrategy`/`FixedDispatchStrategy`
(`trip-service/src/trips/dispatch-mode/`), con fail-fast si un modo no tiene strategy. Un modo nuevo
(EMERGENCY) = 1 clase + 1 línea en el registry + 1 valor de enum. Este ADR NO re-diseña eso: agrega la
dimensión que falta (**qué modos permite cada oferta**).

### Quién consume cada eje HOY (mapa de impacto)

| Consumidor                  | vehicleType (eje 1)                                                                                                                                                                                                                          | category (eje 2)                                      | PricingMode (eje 3)                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **trip-service**            | `createTrip` default CAR (`trips.service.ts:258`), columna `Trip.vehicleType`, evento `trip.bid_posted`/`trip.requested`/`trip.reassigning` enriquecidos                                                                                     | persiste opaco (`:324`); **NO** alimenta la tarifa    | `resolveMode` puro + `PricingScheduleService` (cache+outbox) + `DispatchModeRegistry` (Strategy) + `Trip.dispatchMode` congelado |
| **dispatch-service**        | filtro de matching: `hot-index.port.ts:28`, `redis-hot-index.ts:59` (+default CAR `:167`), `in-memory-hot-index.ts`, `eligibility.gate.ts:105` (bid MOTO solo a MOTO), `kafka-consumers.service.ts:86` (`?? 'CAR'`), gRPC `getNearbyDrivers` | —                                                     | indirecto (consume el evento que el modo eligió)                                                                                 |
| **fleet-service**           | `Vehicle.vehicleType` (certificación del vehículo)                                                                                                                                                                                           | —                                                     | —                                                                                                                                |
| **public-bff**              | `RideCategory.vehicleType` (fare.ts), propaga al create                                                                                                                                                                                      | **dueño** de `RIDE_CATEGORIES` + multiplier + mínimas | `maps.service.ts:93-135`: resuelve modo vía trip-service, degrada a PUJA                                                         |
| **api-client**              | `mobileVehicleType` en quote/createTrip/nearby/board                                                                                                                                                                                         | `category: z.string()` (opaco)                        | `mode` en el quote                                                                                                               |
| **apps (passenger/driver)** | 9 ternarios UI + 3 definiciones locales + store del turno del conductor                                                                                                                                                                      | passenger manda `category` del quote                  | pantalla puja vs fija según `quote.mode`                                                                                         |
| **e2e**                     | golden-path (8 its) crea CAR; pricing-switch (7 its)                                                                                                                                                                                         | implícito                                             | pricing-switch A1-A3/B1-B3/C1                                                                                                    |

---

## 1. Decisión

Un **catálogo tipado EN CÓDIGO** (`ServiceOffering`) como fuente única de los tres ejes, con dos claves de
naturaleza distinta:

- **`VehicleClass`** — enum **CERRADO** (key del pool de matching, certificable server-side por
  fleet-service). Agregar una clase es una decisión operativa (hay que certificar vehículos) → cambio
  explícito de enum, jamás string abierto.
- **`OfferingId`** — ids de producto (`veo_economico`, `veo_moto`, `veo_confort`, `veo_xl`). **NO cambian:
  son contrato con la app** (viajan en el quote y en `createTrip.category`, y están persistidos en
  `Trip.category`). Una oferta nueva = un id nuevo; los existentes son inmutables.

### 1.1 Dónde vive: `packages/shared-types/src/catalog/` (NO package nuevo)

Criterio del import graph, verificado:

- `@veo/shared-types` **ya lo importan** trip-service, dispatch-service, public-bff, fleet-service y las
  TRES apps (`workspace:*` en sus package.json) — cero deps nuevas, cero ciclos (shared-types solo depende
  de zod).
- Un `@veo/catalog` nuevo sería **un package para un módulo**, sin ganancia de aislamiento (mismos
  consumidores exactos) y con costo de plumbing (build, exports, turbo). Over-engineering → rechazado (§3).
- `@veo/api-client` mantiene su política actual de **espejar** el wire (no gana dep runtime). El sync se
  garantiza con un **spec de contrato** (devDependency `@veo/shared-types`, solo test): asserts de que
  `mobileVehicleType.options ≡ Object.values(VehicleClass)` y de que los ids de offering del quote ≡
  `Object.keys(OFFERINGS)`. Si alguien agrega una clase y olvida el espejo, el CI lo grita.

### 1.2 La forma exacta (tipos reales)

```ts
// packages/shared-types/src/catalog/offerings.ts
import { PricingMode, VehicleType } from '../enums';

/** Alias semántico: la KEY del pool de matching. El wire field sigue siendo `vehicleType` (contrato). */
export const VehicleClass = VehicleType; // mismo objeto: CAR | MOTO (cerrado)
export type VehicleClass = VehicleType;

export const OfferingId = {
  VEO_MOTO: 'veo_moto',
  VEO_ECONOMICO: 'veo_economico',
  VEO_CONFORT: 'veo_confort',
  VEO_XL: 'veo_xl',
} as const; // ids = contrato con la app: INMUTABLES
export type OfferingId = (typeof OfferingId)[keyof typeof OfferingId];

/** Token de ícono que la app resuelve en SU registro token→glyph (mata los ternarios MOTO). */
export const OfferingIcon = { CAR: 'car', MOTO: 'moto' } as const; // futuro: 'ambulance', 'wrench'…
export type OfferingIcon = (typeof OfferingIcon)[keyof typeof OfferingIcon];

export interface OfferingPricingPolicy {
  /** Multiplicador sobre la fórmula base BR-T05 (económico = 1.0). Hoy vive en fare.ts del BFF. */
  multiplier: number;
  /** Tarifa mínima cobrable, céntimos PEN (moto 300, autos 500). Hoy `minFareForCategory`. */
  minFareCents: number;
}

/** Flujo de despacho. MVP: STANDARD único. EMERGENCY (ambulancia) = valor + strategy futuros. */
export const OfferingFlow = { STANDARD: 'STANDARD' } as const;
export type OfferingFlow = (typeof OfferingFlow)[keyof typeof OfferingFlow];

export interface OfferingSpec {
  id: OfferingId;
  /** Token i18n (`offering.veo_moto.name`); la app resuelve. El quote SIGUE mandando `name` resuelto
   *  server-side para apps viejas (compat). */
  labelKey: string;
  icon: OfferingIcon;
  /** Pool de matching certificable: dispatch filtra por ESTO (deriva del offering, no viaja suelto). */
  vehicleClass: VehicleClass;
  pricing: OfferingPricingPolicy;
  /** Modos que la oferta PERMITE. NUNCA vacío (spec del catálogo lo verifica). El primero es el
   *  PREFERIDO: gana cuando el schedule del admin pide un modo que la oferta no permite (§1.3). */
  allowedModes: readonly [PricingMode, ...PricingMode[]];
  flow: OfferingFlow;
  /** Orden de presentación en el quote (hoy: orden del array RIDE_CATEGORIES). */
  sortOrder: number;
}
```

> **🔗 EXTENSIÓN POSTERIOR (era ADR-017 · trazabilidad):** este `OfferingSpec` se **extendió** después con el campo
> **`requires`** (elegibilidad del vehículo por atributos: `minSeats` / `minSegment` / `maxAgeYears` / certificaciones) —
> la base de la **"elegibilidad de oferta / tier"** (`vehicleMeetsRequirements`, `offerings.ts`). El snapshot de arriba es
> el de ADR-013 (2026-06-11) y NO lo incluye: el `requires` nace con el tier de calidad de **ADR-017 §1.2**. Cierra el
> hueco de trazabilidad "¿de dónde salió `requires`?". Vocabulario canónico y la distinción **operabilidad vs
> elegibilidad de oferta**: [`VEO_MODELO_HIBRIDO §1.5`](../../specs/VEO_MODELO_HIBRIDO.md).

```ts
export const OFFERINGS = {
  [OfferingId.VEO_MOTO]: {
    id: OfferingId.VEO_MOTO,
    labelKey: 'offering.veo_moto.name',
    icon: OfferingIcon.MOTO,
    vehicleClass: VehicleClass.MOTO,
    pricing: { multiplier: 0.55, minFareCents: 300 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 0,
  },
  [OfferingId.VEO_ECONOMICO]: {
    id: OfferingId.VEO_ECONOMICO,
    labelKey: 'offering.veo_economico.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.0, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 1,
  },
  [OfferingId.VEO_CONFORT]: {
    id: OfferingId.VEO_CONFORT,
    labelKey: 'offering.veo_confort.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.25, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 2,
  },
  [OfferingId.VEO_XL]: {
    id: OfferingId.VEO_XL,
    labelKey: 'offering.veo_xl.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.6, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 3,
  },
} as const satisfies Record<OfferingId, OfferingSpec>;

export const OFFERING_LIST: readonly OfferingSpec[] = Object.values(OFFERINGS).sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

/** Lookup tolerante para input del cliente (string crudo): undefined si no existe — el caller decide. */
export function findOffering(id: string): OfferingSpec | undefined {
  return (OFFERINGS as Record<string, OfferingSpec>)[id];
}
```

`as const satisfies Record<OfferingId, OfferingSpec>` = exhaustividad en compile-time: un `OfferingId`
nuevo sin entrada en `OFFERINGS` **no compila**. Los multiplicadores/mínimas son los de `fare.ts` actual,
movidos — no se inventan números.

**NO va tabla + panel admin todavía (YAGNI):** los valores cambian al ritmo de releases, no de operación.
Si negocio pide editarlos en caliente, la plantilla ya existe y está probada en este repo:
`PricingModeSchedule` singleton + `version` + outbox (`pricing-schedule.service.ts`) — se replica tal cual
para un `OfferingCatalog` versionado. Ese día el registro en código pasa a ser el **default/fallback**.

### 1.3 Resolución del modo: `offering.allowedModes ∩ schedule` — precedencia EXACTA

```ts
// shared-types/src/catalog (pura, unit-testeable; trip-service la consume)
export function resolveOfferingMode(
  offering: OfferingSpec,
  scheduledMode: PricingMode,
): {
  mode: PricingMode;
  /** true si el schedule pidió un modo que la oferta NO permite (observabilidad: warn + counter). */
  overridden: boolean;
} {
  if (offering.allowedModes.includes(scheduledMode)) return { mode: scheduledMode, overridden: false };
  return { mode: offering.allowedModes[0], overridden: true };
}
```

Precedencia, en orden:

1. **El schedule del admin propone**: `scheduledMode = PricingScheduleService.resolve(zone, at)` —
   intacto de ADR 011 (cache, default PUJA, lock-at-booking S2 para reservas).
2. **La oferta acota**: si `scheduledMode ∈ allowedModes` → ese es el modo. El admin manda _dentro de lo
   que la oferta permite_.
3. **Conflicto (schedule dice PUJA pero la oferta solo permite FIXED)**: **gana la oferta** con su modo
   preferido (`allowedModes[0]`), `overridden: true` → trip-service loguea `warn` + bumpea un counter
   (`pricing_offering_mode_overridden`). Razón: `allowedModes` codifica un invariante de producto/seguridad
   ("la ambulancia NO negocia precio") que un schedule horario genérico no puede violar; el schedule es
   configuración, la oferta es dominio. El counter hace el conflicto VISIBLE al admin en vez de silencioso.
4. **Congelado**: el resultado se persiste en `Trip.dispatchMode` (resolve-once-persist-forever, ADR 011
   §1.2 — intacto). Reasignación y activación de reservas siguen leyendo el modo del viaje.

El **quote** aplica la MISMA intersección por opción: `options[].mode` (campo nuevo, additive) para que la
app pinte pantalla de puja o de precio firme POR oferta. El `mode` top-level actual se mantiene (compat con
apps viejas; semántica: el modo de la oferta ancla `veo_economico`).

Con las 4 ofertas actuales `allowedModes = [PUJA, FIXED]` → la intersección es **no-op**: el
comportamiento de hoy no cambia hasta que exista una oferta restringida. Eso hace la migración segura.

### 1.4 Modos nuevos = Strategy (ya existe) + entrada en catálogo

`DispatchModeRegistry` ya implementa el patrón (Lote S). EMERGENCY (ambulancia) cuando llegue =
`PricingMode.EMERGENCY` + `EmergencyDispatchStrategy` + 1 línea en el registry + la oferta lo declara en
`allowedModes`. `createTrip`/`reassign`/`activateScheduled` NO se tocan. El `forMode()` que lanza si falta
strategy ya es el fail-fast correcto.

### 1.5 `assertNever` en @veo/utils (YA existe — se consume, no se re-crea)

Verificado en el working tree de este mismo Lote P: `packages/utils/src/assert.ts` ya exporta

```ts
export function assertNever(value: never, message = 'Variante no contemplada'): never;
```

re-exportado desde el index del package y con 3 specs en `utils.spec.ts` (runtime lanza, mensaje
propio, switch exhaustivo compila). Este ADR lo **consume** tal cual — NO se crea un segundo helper
ni se cambia su firma. Uso obligatorio en todo switch sobre `VehicleClass`/`PricingMode`/`OfferingFlow` que sobreviva (la mayoría
de los ternarios MOTO **desaparecen** por UI data-driven, no se convierten en switches). Cero `default`
silenciosos.

### 1.6 UI data-driven (mata los 9 ternarios)

Las apps dejan de preguntar `=== 'MOTO'`: renderizan desde `{icon, labelKey}` del offering/clase.

- **Un** registro token→glyph por app: `OFFERING_GLYPHS: Record<OfferingIcon, Component>` (passenger
  `VehicleIcon`, driver `VehicleStatusCard`/`BidCard`). Token desconocido (app vieja vs server nuevo) →
  glyph genérico CAR como fallback EXPLÍCITO del registro, no un ternario.
- Labels: `t(offering.labelKey)`; para flujos por clase (driver `BidCard`), `t(vehicleClassLabelKey[clase])`
  con `Record<VehicleClass, string>` exhaustivo (compile-time).
- El selector de registro del driver (`VehicleTypeSelector`) itera `VEHICLE_CLASSES` de shared-types en vez
  de dos `<Chip>` hardcodeados.
- Las 3 definiciones locales de apps (eje 1 #4-6) se reemplazan por imports de `@veo/shared-types` (ya es
  dependencia de ambas apps — verificado en package.json).

### 1.7 El bug del multiplier: se arregla EN la migración (Lote B), no antes

Arreglarlo "antes" exigiría duplicar la tabla categoría→multiplier DENTRO de trip-service (hoy solo la
tiene el BFF) — más acumulación del eje 2, exactamente lo que este ADR mata. En cambio, en el primer lote
que toca trip-service (B), `createTrip` resuelve el offering desde `dto.category` y pasa
`offering.pricing` al Strategy:

```ts
// DispatchCreationInput (extensión additive)
pricing: OfferingPricingPolicy; // FixedDispatchStrategy: calculateFare(...) × multiplier, max(minFareCents)
```

PUJA no cambia (el bid ES la tarifa; el multiplier solo afecta el `suggestedCents` del quote, que ya lo
aplica). La ventana de des-sincronía quote↔tarifa-firme **ya existe en prod hoy**; este plan la cierra en
el primer lote de backend, no introduce regresión nueva. `categoryFareCents` (BFF) y el nuevo cálculo de
trip-service comparten la política desde el catálogo → el espejo de constantes BFF↔trip-service (declarado
en el header de `fare.ts`) deja de poder divergir en multiplicadores/mínimas.

---

## 2. Caminos infelices del diseño

| ¿Y si…?                                                             | Resultado                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dto.category` desconocido (cliente roto/malicioso)                 | **400 `UNKNOWN_OFFERING`** (ValidationError tipado). Es seguro: los ids siempre nacen del quote del server — un id que no está en el catálogo no puede venir de un cliente honesto. NUNCA default silencioso a económico (cobrarías un precio que el pasajero no vio).                                                                                                                              |
| `dto.category` AUSENTE (cliente viejo: el campo es opcional hoy)    | Compat: se deriva la oferta default por `dto.vehicleType` → MOTO→`veo_moto`, CAR/ausente→`veo_economico` (replica el comportamiento actual: multiplier efectivo 1.0 era el bug; ahora moto obtiene su política real). Precedencia: `category` > `vehicleType` > default económico.                                                                                                                  |
| `category` y `vehicleType` inconsistentes (ej. `veo_moto` + CAR)    | **La oferta gana** (`offering.vehicleClass` es la fuente del pool); se loguea warn. No 400: apps viejas ya en la calle mandan ambos y un bug de UI no debe romperles el create.                                                                                                                                                                                                                     |
| schedule dice PUJA pero la oferta solo permite FIXED                | La oferta gana con `allowedModes[0]` + warn + counter `pricing_offering_mode_overridden` (§1.3.3). El flip del admin NUNCA hace negociar a una ambulancia.                                                                                                                                                                                                                                          |
| vehicleClass sin pool de conductores en la zona (cero motos online) | NO se bloquea ni el quote ni el create (pool vacío AHORA ≠ vacío en 30s; el gate sería una carrera). El flujo existente ya degrada honesto: FIXED → matching agota → `EXPIRED`/NoOffers; PUJA → sin ofertas → `EXPIRED` (ADR 010). Follow-up additive opcional: `options[].nearbyCount` (dispatch `getNearbyDrivers` ya filtra por clase) para que la app muestre "sin motos cerca" ANTES de pedir. |
| oferta nueva en el server, app vieja                                | El quote ya manda `name` resuelto server-side (se mantiene) → la app vieja la lista con nombre correcto; ícono → fallback genérico del registro de glyphs. La app vieja puede crearla (el id viene del quote).                                                                                                                                                                                      |
| modo nuevo (EMERGENCY) llega a una app vieja en `options[].mode`    | La app vieja no conoce la pantalla → cae a su rama por-defecto (puja). Mitigación: una oferta con modo nuevo se lanza con versión mínima de app (gate por feature-flag de quote, fuera de alcance de este ADR).                                                                                                                                                                                     |
| el catálogo crece y negocio quiere editarlo sin release             | Se replica la plantilla `PricingModeSchedule` singleton+version+outbox (probada) con el registro en código como fallback. NO se construye hoy (YAGNI §3).                                                                                                                                                                                                                                           |

---

## 3. Alternativas consideradas

- **Package nuevo `@veo/catalog`** — pros: límite explícito. Contras: un package para UN módulo, mismos
  consumidores que shared-types, más plumbing (build/exports/turbo) y una dep nueva en 7 proyectos.
  **Rechazada**: shared-types ya está en el import graph de TODOS los consumidores sin ciclos.
- **Tabla en DB + panel admin desde el día 1** — pros: editable en caliente. Contras: los valores cambian
  al ritmo de releases; exige proyección/cache/versionado en 3 servicios + UI + RBAC, hoy sin demanda.
  **Rechazada (YAGNI)** — con plantilla de escape documentada (§1.2, §2 última fila).
- **`OfferingId` como string abierto** — pros: cero fricción para agregar. Contras: mata la exhaustividad
  compile-time y el matching certificable; un typo se vuelve una oferta fantasma persistida.
  **Rechazada**: enum cerrado + `findOffering` tolerante SOLO en el borde de input.
- **Renombrar el wire field `vehicleType` → `vehicleClass`** — rompe eventos Kafka, columnas Prisma,
  api-client y apps en la calle, sin ganancia funcional. **Rechazada**: `VehicleClass` es alias semántico
  en tipos; el wire conserva `vehicleType`.
- **Strategy nueva para la selección de modo** — ya existe la separación correcta (resolver puro ADR 011 +
  `DispatchModeRegistry` Lote S). Meter otra capa sería patrón de más. **Rechazada**: solo se agrega la
  función pura de intersección (§1.3).

---

## 4. Consecuencias

**Positivas:** agregar una oferta = 1 entrada en `OFFERINGS` (+1 valor de `VehicleClass` si es pool nuevo,
+1 token de ícono); agregar un modo = 1 Strategy + 1 línea de registry + declararlo en `allowedModes`;
el bug del multiplier queda cerrado estructuralmente (una sola política de pricing); los 9 ternarios y las
5 definiciones duplicadas desaparecen; "ambulancia no negocia" es un invariante de dominio, no una
esperanza de configuración.

**Negativas / costos:** shared-types gana un módulo con semántica de dominio (ya pasaba con `enums/`);
cambiar un multiplicador requiere release (aceptado, escape documentado); el spec de sync api-client agrega
una devDep; `options[].mode` agranda el payload del quote (4 strings).

---

## 5. Plan de lotes (P4-apply backend · P5 apps) — cada lote verificable

> Regla: cada lote deja el repo VERDE (typecheck + specs + e2e). El e2e de referencia: golden-path (8 its)
> y pricing-switch (7 its, `e2e/pricing-switch/pricing-switch.e2e.spec.ts`). Golden-path crea viajes CAR
> económico (multiplier 1.0) → los montos NO cambian en ningún lote: si un e2e cambia de expectativa, es
> señal de regresión, no de "ajuste".

| Lote                                                           | Qué entra                                                                                                                                                                                                                                                                                                                                                                                | Gate de verificación                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — packages (sin tocar servicios)**                         | `catalog/` en shared-types (`VehicleClass` alias, `OfferingId`, `OFFERINGS`, `findOffering`, `resolveOfferingMode`) — consume el `assertNever` que YA está en `@veo/utils` (§1.5), no lo re-crea · specs unitarios del catálogo (ids estables = snapshot de contrato, `multiplier > 0`, `allowedModes` no vacío, `satisfies` compila) · spec de sync en api-client (devDep shared-types) | `pnpm typecheck` global + specs de utils/shared-types/api-client. e2e intacto por construcción (nada lo importa aún).                                                                                                     |
| **B — trip-service (cierra el bug)**                           | `createTrip`: resuelve offering (`category` > `vehicleType` > default, 400 `UNKNOWN_OFFERING`), `vehicleClass` deriva del offering, modo = `resolveOfferingMode(offering, schedule)` + warn/counter · `DispatchCreationInput.pricing` → `FixedDispatchStrategy` aplica multiplier + minFare                                                                                              | Specs trip-service (casos nuevos: offering desconocido→400, conflicto de modos→override+flag, confort FIXED cobra ×1.25) · golden-path 8/8 · pricing-switch 7/7 **sin cambiar expectativas** (ambos usan económico ×1.0). |
| **C — public-bff**                                             | `fare.ts` deja de definir `RIDE_CATEGORIES`/mapeos: importa `OFFERING_LIST` (la fórmula `categoryFareCents` queda, alimentada por `offering.pricing`) · quote agrega `options[].mode`, `labelKey`, `icon` (additive; `name` y `mode` top-level se mantienen)                                                                                                                             | `fare.spec` + `waypoints-fare.spec` + specs de maps verdes con los MISMOS montos (la política movida, no cambiada) · golden-path + pricing-switch verdes.                                                                 |
| **D — dispatch-service + driver-bff (tipado, sin estructura)** | dispatch ya filtra por clase: solo tipar con `VehicleClass`, `assertNever` en switches restantes, eliminar defaults `?? 'CAR'` que oculten clases nuevas donde sea seguro (el de pings legacy `redis-hot-index.ts:167` se queda: datos viejos reales)                                                                                                                                    | Specs dispatch (eligibility, hot-index, consumers) verdes sin debilitar.                                                                                                                                                  |
| **P5-1 — passenger**                                           | Registro `OFFERING_GLYPHS` + render desde `options[].icon/labelKey` (fallback server `name`) · borra ternarios de `VehicleIcon` ×2, `RouteQuoteScreen`, `QuotingBody`, `TripHistoryRow` · `NearbyVehicleType` → import shared-types                                                                                                                                                      | `__tests__` passenger verdes (createTrip.test sigue mandando `category`+`vehicleType`: contrato intacto) + typecheck app.                                                                                                 |
| **P5-2 — driver**                                              | `vehicle-type.ts` y `registration/entities` re-exportan desde shared-types (los specs `vehicle-type.test`/`vehicleTypeStore.test` siguen pasando contra la re-export — si un assert cambia, se justifica en el PR) · `VehicleTypeSelector` data-driven · `BidCard`/`VehicleStatusCard` por registro de tokens                                                                            | Specs driver verdes + typecheck app.                                                                                                                                                                                      |
| **Prueba de fuego (post-P5, opcional en rama)**                | Agregar `VEO_AMBULANCIA` de mentira (`allowedModes: [FIXED]`) y verificar que SOLO se tocan: 1 enum value, 1 token, 1 entrada de catálogo, 1 glyph — y que el override de modo emite el counter                                                                                                                                                                                          | Demo del criterio del dueño: extender AGREGANDO. Se revierte tras la demo.                                                                                                                                                |

Orden estricto A→B→C→D→P5: B y C dependen de A; D y P5 dependen de C solo por los campos nuevos del quote
(pueden paralelizarse con D). Ningún lote requiere migración de datos (`Trip.category` ya persiste los
mismos ids; `Trip.vehicleType` no cambia de valores).

---

## 6. Referencias

- ADR 010 (modelo de puja) · ADR 011 (switch PUJA↔FIJO por horario — schedule, resolver, persist-once)
- Código auditado: `services/bff/public-bff/src/maps/fare.ts` (catálogo actual + bug),
  `services/trip-service/src/trips/trips.service.ts:258-335` (createTrip),
  `services/trip-service/src/trips/dispatch-mode/` (Strategy existente),
  `services/trip-service/src/trips/domain/pricing-mode.ts` (resolver ADR 011),
  `services/dispatch-service/src/dispatch/eligibility.gate.ts` (gate por clase),
  `packages/shared-types/src/enums/index.ts` (VehicleType/PricingMode canónicos)
- Plantilla de escape a config en caliente: `services/trip-service/src/pricing/pricing-schedule.service.ts`
  (singleton + version + outbox)
