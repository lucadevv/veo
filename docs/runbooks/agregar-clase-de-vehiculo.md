# Runbook · Agregar una clase de vehículo (VehicleClass)

> Procedimiento medido por la **prueba de fuego del ADR 013** (VEO_AMBULANCIA, ejecutada y revertida):
> **19 archivos** para una oferta con **clase NUEVA** · **~4 archivos** para una oferta de **clase
> EXISTENTE** (catálogo + snapshot + display name + ids de fare.spec — el caso común del negocio).
> Referencia: `docs/adr/013-catalogo-service-offerings.md`.

## Cuándo usar este runbook

- Vas a agregar una **clase de vehículo nueva** (ej. `AMBULANCE`): seguí TODO este checklist.
- Vas a agregar una **oferta de una clase existente** (ej. `veo_premium` sobre CAR): solo la sección
  "Puntos guiados" aplica, y de ella solo catálogo + snapshot + display name + fare.spec (~4 archivos).
  Glyphs, i18n, enums, Prisma y el wire de events NO se tocan porque la clase ya existe.

## Resumen del orden seguro

1. Enum canónico + catálogo (`@veo/shared-types`) → el compilador y los specs te arrastran por los puntos guiados.
2. **Prisma ×3 + migración** (paso MANUAL — nadie lo grita en compile) y **deploy de la migración ANTES que el código**.
3. Verificación final: typecheck global + suites + e2e golden con montos invariantes.

---

## (a) Puntos GUIADOS — el compilador y los specs te llevan de la mano

Arrancá por el enum y dejá que typecheck/tests te griten el resto. En orden de dominó:

| #   | Archivo                                                                                                   | Qué tocás                                                                                          | Quién te lo grita                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `packages/shared-types/src/enums/index.ts`                                                                | `VehicleType` (alias `VehicleClass`): la clase nueva                                               | — (acá empieza el dominó)                                                                                                      |
| 2   | `packages/shared-types/src/catalog/offerings.ts`                                                          | `OfferingId` nuevo + entrada en `OFFERINGS` + token en `OfferingIcon`                              | `as const satisfies Record<OfferingId, OfferingSpec>`: un id sin entrada NO compila                                            |
| 3   | `packages/shared-types/test/offerings.spec.ts`                                                            | snapshot del catálogo (ids/política)                                                               | el propio spec al correr `pnpm --filter @veo/shared-types test`                                                                |
| 4   | `packages/api-client/src/mobile.ts`                                                                       | `mobileVehicleType`: espejo LITERAL del enum (decisión Lote A: cero dependencia runtime en la app) | `packages/api-client/test/offerings-sync.contract.test.ts` — el spec de sync caza el olvido (la prueba de fuego lo demostró)   |
| 5   | `services/bff/public-bff/src/maps/offering-names.ts`                                                      | display name de la oferta                                                                          | `Record<OfferingId, string>` exhaustivo: no compila sin la entrada                                                             |
| 6   | `services/bff/public-bff/src/maps/dto/maps.dto.ts` + `fare.ts`                                            | DTO del quote / ids de tarifa                                                                      | typecheck + `maps.service.spec` / `fare.spec` (snapshot de ids; el spec "every PUJA" asierta el INVARIANTE de modo por oferta) |
| 7   | `apps/passenger/src/shared/presentation/components/offeringGlyphs.tsx`                                    | glyph/tono/ícono de la oferta (`Record<OfferingIcon, …>`)                                          | typecheck del Record + `apps/passenger/__tests__/offeringGlyphs.test.ts`                                                       |
| 8   | `apps/driver/src/shared/presentation/vehicle-class.ts` + `VehicleTypeSelector.tsx` (registration y shift) | clase visible para el conductor                                                                    | typecheck + `vehicle-class.test.ts`                                                                                            |
| 9   | `apps/passenger/src/i18n/locales/*` y `apps/driver/src/i18n/locales/*`                                    | labels de la clase/oferta                                                                          | specs de i18n/snapshots de las apps                                                                                            |

> Los **eventos del wire** ya NO están en esta lista como paso manual: ver (c).

## (b) Puntos MANUALES — Prisma ×3 + migración (nadie te los grita en compile)

Los schemas de Prisma son **espejos de la DB por servicio** (convención del repo: cada servicio es
dueño de su schema; NO derivan de `@veo/shared-types`). El compilador NO se entera si te los olvidás:
sin migración, el primer `INSERT` con la clase nueva **explota en runtime** (`invalid input value for
enum`). La prueba de fuego lo confirmó: este es el único paso 100 % silencioso.

Tocá el `enum VehicleType` en los TRES servicios que lo persisten:

| Servicio         | Archivo                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| trip-service     | `services/trip-service/prisma/schema.prisma` (enum `VehicleType`, línea ~79) |
| dispatch-service | `services/dispatch-service/prisma/schema.prisma` (línea ~29)                 |
| fleet-service    | `services/fleet-service/prisma/schema.prisma` (línea ~61)                    |

Y generá la migración POR SERVICIO (regenera además el client tipado — sin esto, los specs
parametrizados por clase no typecheckean, porque `Trip.vehicleType` sigue siendo el enum viejo):

```bash
pnpm --filter @veo/trip-service exec prisma migrate dev --name add-vehicle-class-<clase>
pnpm --filter @veo/dispatch-service exec prisma migrate dev --name add-vehicle-class-<clase>
pnpm --filter @veo/fleet-service exec prisma migrate dev --name add-vehicle-class-<clase>
```

### Orden de deploy: la migración VA ANTES que el código. Sí, siempre.

`ALTER TYPE ... ADD VALUE` es **aditivo y backwards-compatible**: el código viejo ignora el valor
nuevo del enum sin romperse. El orden inverso NO es seguro: código nuevo contra DB vieja insertaría
la clase nueva y explotaría en runtime. Por eso:

1. **Deploy de la migración** (los 3 servicios): `pnpm --filter @veo/<svc> db:migrate` (= `prisma migrate deploy`).
2. **Deploy del código** (servicios + BFFs) recién cuando las 3 DBs tienen el valor.
3. Apps móviles al final (el wire ya acepta la clase; clientes viejos siguen mandando las suyas).

## (c) Eventos del wire — AUTOMÁTICO (mini-lote "abrir el wire")

Los schemas `trip.*`/`driver.*`/`fleet.*` de `@veo/events` **derivan** la clase del enum canónico:
`vehicleClassSchema = z.enum(Object.values(VehicleClass) …)` en `packages/events/src/schemas.ts`,
usado por los 5 sitios con `vehicleType` (`trip.requested`, `trip.bid_posted`, `trip.reassigning`,
`driver.location_updated`, `fleet.vehicle_registered`). Agregar la clase al enum (paso a-1) **abre el
wire solo** — ya no existe el modo de falla de la prueba de fuego, donde un evento con la clase nueva
moría EN SILENCIO en el gate del consumer (`packages/events/src/kafka.ts`: `safeParse` → descarta).

Doble red: el contrato producer↔schema de trip-service
(`services/trip-service/src/trips/trips.service.spec.ts`, describe «CONTRATO producer↔schema ·
parametrizado POR CLASE») itera `Object.values(VehicleClass)` contra los payloads REALES del producer.
La clase nueva queda cubierta sola; si alguien re-hardcodea el `z.enum(['CAR','MOTO'])` en events,
ese spec GRITA.

## (d) Verificación final

```bash
pnpm typecheck                                   # global: Records exhaustivos + espejos tipados
pnpm --filter @veo/shared-types --filter @veo/events --filter @veo/api-client test
pnpm --filter @veo/trip-service --filter @veo/public-bff test
pnpm --filter @veo/passenger --filter @veo/driver test   # glyphs/i18n/snapshots de las apps
pnpm e2e:golden                                  # golden path contra el dev-stack
```

Criterio de salida del e2e: los **montos del golden path son INVARIANTES** — agregar una clase/oferta
nueva NO puede mover un céntimo de las ofertas existentes (la prueba de fuego lo verificó: económico
1500, moto 825, etc. idénticos pre/post). Si un monto cambió, tocaste política de pricing ajena.

## Evidencia (prueba de fuego, memoria del proyecto)

- Ejecutada el 2026-06-11 (`abordar/adr013-prueba-fuego`): se agregó `VEO_AMBULANCIA` (clase nueva,
  solo-FIXED), se midió y se revirtió byte-idéntico.
- **19 archivos** para clase nueva (núcleo previsto por el ADR ~9 + specs de contrato que gritaron +
  forzados por typecheck + los 3 prisma manuales) · **~4 archivos** para oferta de clase existente.
- Gaps que esa medición confirmó (y este runbook + el mini-lote cierran): wire de events castea en
  silencio (resuelto: derivación), Prisma manual sin guía (resuelto: sección b), contract test con
  fixture CAR fijo (resuelto: parametrizado por clase).
