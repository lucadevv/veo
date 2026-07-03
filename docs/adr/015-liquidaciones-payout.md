# ADR 015 — Liquidaciones y payout: el conductor COBRA de verdad (`PayoutGateway` money-OUT)

> Estado: **RATIFICADO** (Cimiento de finanzas · ADR sin código). Decisiones del dueño cerradas (§1, §11).
> Cierra la última de las tres áreas de finanzas que estaba **sin ADR**. Materializa el **desembolso real**
> de la liquidación: hoy `PROCESSED` es un flag de DB + un evento de auditoría, pero **ningún componente
> mueve la plata a la billetera del conductor**, y el cobro de carpooling **nunca entra** a la liquidación.
>
> ⚠️ **EXTENDIDO por [ADR-017](./017-modelo-pricing-energia-tiers.md) (2026-06-26):** la **comisión** deja de
> ser una sola rate global por env (`COMMISSION_RATE`) y pasa a **configurable por país y por modo** (on-demand
> vs carpooling). El nudo legal "comisión sobre el bruto" en el cost-sharing del carpooling (§11.2 de este ADR)
> sigue vigente como decisión abierta a validar con legal PE/EC.
> Refina (no reemplaza) ADR 013 (catálogo/pricing), ADR 014 (carpooling/`booking-service`) y la política de
> comisión del on-demand. Es el **espejo money-OUT** del CHARGE money-IN del payment-service.

---

## 0. Contexto y problema

La auditoría de finanzas (3 áreas: COBRO, COMISIÓN, LIQUIDACIÓN) confirmó que **Liquidaciones es la única
sin ADR**, y que detrás del nombre "payout procesado" no hay desembolso. Cuatro huecos, todos con evidencia
nivel-1 (`file:línea` del working tree, verificado 2026-06-25):

### Hueco 1 — CRÍTICO: el conductor de carpooling NUNCA cobra payout

El cobro del carpooling nace huérfano de conductor y queda **fuera** de la liquidación:

- `booking-service` dispara el CHARGE sin `driverId`: en `triggerCharge`
  (`services/booking-service/src/bookings/bookings.service.ts:581`) el `this.payment.charge({...})` pasa
  `bookingId / grossCents / method / passengerId` y **omite `driverId`** — pese a que el contrato del puerto
  YA lo soporta (`ChargeInput.driverId?`, `services/booking-service/src/ports/payment/payment-gateway.port.ts:43`)
  y `trip.driverId` está disponible en ambos caminos del flujo (INSTANT en `reserve`
  `bookings.service.ts:249,262` y el `approve` `bookings.service.ts:328-357`).
- Sin `driverId`, el Payment nace `driverId: input.driverId ?? null`
  (`services/payment-service/src/payments/payments.service.ts:267`).
- El cron de payout agrega solo cobros CON conductor: `driverId: { not: null }`
  (`services/payment-service/src/payouts/payouts.service.ts:353`).

**Resultado:** el ticket del carpooling se cobra al pasajero, la comisión se computa, pero **el neto del
conductor NUNCA se liquida** (queda excluido por el filtro `not: null`) y la comisión retenida se queda en
la plataforma sin contraparte. El arreglo es de **una línea de wiring** (pasar el `driverId` que ya existe),
no un rediseño.

### Hueco 2 — CRÍTICO: el payout NO desembolsa de verdad

`PROCESSED` es un **flag de DB + un evento de auditoría**, no una transferencia:

- En el cron, el Payout nace directo en `status: flagged ? 'HELD' : 'PROCESSED'`
  (`payouts.service.ts:187`) y, si no está flaggeado, se emite `payout.processed` al outbox
  (`payouts.service.ts:203,212`) — **dentro de la misma transacción** que crea el Payout.
- **No existe ningún método de desembolso.** El puerto `PaymentGateway`
  (`services/payment-service/src/ports/gateway/payment-gateway.port.ts:144-161`) expone solo
  `charge` / `supports` / `getStatement` (+ `refund` opcional vía `Refundable`). **NINGÚN `disburse`.**
- El evento `payout.processed` lo consume **solo audit-service**
  (`services/audit-service/src/consumers/audit.consumer.ts:194`) → escribe una fila de auditoría.
  **Ningún consumidor transfiere plata.**

**Resultado:** "liquidación procesada" es una etiqueta. La plata del conductor **nunca sale** del sistema.

### Hueco 3 — estados muertos: `PROCESSING` y `FAILED` jamás se alcanzan

La policy declara una máquina completa:

```ts
// services/payment-service/src/payouts/payout.policy.ts:79-87
const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  PENDING:    ['PROCESSING', 'PROCESSED', 'HELD', 'FAILED'],
  PROCESSING: ['PROCESSED', 'FAILED'],
  HELD:       ['PROCESSED'],
  FAILED:     ['PROCESSING', 'PROCESSED'],
  PROCESSED:  [], // terminal
};
```

Pero el cron **nace directo en `PROCESSED` o `HELD`** (`payouts.service.ts:187`) → `PENDING`, `PROCESSING` y
`FAILED` **nunca se materializan**. La máquina describe un ciclo asíncrono de desembolso que el código no
ejerce: estados muertos esperando que exista el desembolso real.

### Hueco 4 — el admin FINANCE ve un monto OPACO

`toPayoutView` (`services/bff/admin-bff/src/finance/finance.service.ts:118-126`) expone solo
`id / driverId / amountCents / status / period` y **descarta `grossCents`/`commissionCents`** que el modelo
Payout SÍ persiste (`services/payment-service/prisma/schema.prisma:204-205`). El contrato `payoutView`
(`packages/api-client/src/types.ts:205-212`) tampoco los tiene. El operador ve el **neto** sin poder
auditar bruto ni comisión — paridad rota con lo que el conductor ve en su app.

### Hueco 5 (nota a documentar) — el bono se marca pagado aunque la plata no salió

El `paidAt` del incentivo se marca **en la MISMA transacción** que crea el Payout `PROCESSED`:

```ts
// services/payment-service/src/payouts/payouts.service.ts:198 (dentro de la tx del create Payout)
data: { paidAt: new Date(), paidInPayoutId: payout.id },
```

Con `PROCESSED` optimista (hueco 2), el bono queda **marcado pagado aunque el desembolso jamás ocurrió** →
riesgo **bono-perdido** el día que se conecte el riel real. Este ADR lo cierra atando el `paidAt` al
`PROCESSED` **confirmado** (§1 D5).

### Lo que YA está bien (no se re-litiga)

- **Comisión money-IN**: `commission(gross, rate)` con `COMMISSION_RATE` default `0.2` (20%,
  `services/payment-service/src/config/env.schema.ts:33`) ya se computa y persiste en el Payment.
- **Step-up MFA del operador (BR-S07)**: el gate por umbral ya existe
  (`payouts.service.ts:140,296`) — el operador con MFA fresca dispara/libera; sin MFA fresca sobre el
  umbral → `ForbiddenError`. Este ADR lo **reusa**, no lo reinventa.
- **Outbox + máquina de estados tipada**: la policy `assertTransition` ya está; solo faltaba **ejercer** los
  estados.

---

## 1. Decisión

Siete decisiones, cerradas por el dueño. El hilo conductor: **el payout deja de ser un flag optimista y pasa
a ser un desembolso real, asíncrono, detrás de un puerto soberano**, disparado por el operador.

### D1 — Comisión en carpooling = SOBRE EL BRUTO (espejo exacto del on-demand)

> ⚠️ **SUPERSEDED (2026-06-27) por ADR-017 §1.6 / F2.7-v2 (commit `18145d7`), tras investigar BlaBlaCar/inDrive.**
> El modelo de D1 (comisión sobre el bruto del conductor) era ERRÓNEO para carpooling. El modelo CORRECTO
> (BlaBlaCar): la comisión del carpooling es un **SERVICE FEE que paga el PASAJERO, sumado arriba** de la
> contribución; el conductor cobra el **100%** de su contribución (la plataforma NO le descuenta nada). El
> pasajero paga `contribución + fee`. **Así DESAPARECE la tensión legal de §11.2** — el fee es del pasajero, no
> lucro sobre el costo-compartido del conductor. La comisión carpooling es admin-editable, sin bloqueo legal.
> (Esta nota REEMPLAZA la supersesión previa que decía "carpooling 0% fijo", que también quedó obsoleta.) El
> texto original de abajo se conserva como registro histórico — NO refleja el código vigente.

VEO retiene **`COMMISSION_RATE` (hoy 20%) del precio del asiento** del carpooling; el conductor recibe el
**neto**. El carpooling **reusa el MISMO carril de comisión** que el on-demand: NO hay rate diferenciado, NO
hay una segunda fórmula. La comisión se computa con `commission(gross, rate)` igual que para un viaje AHORA;
el `grossCents` del Payout es el ticket del asiento, el `commissionCents` su retención, el `amountCents` el
neto al conductor.

> Esta decisión arrastra una **tensión legal/de-producto real** del modelo cost-sharing. Se documenta con
> honestidad como riesgo/follow-up en §11.2 (no se esconde): aplicar comisión sobre un bruto ya topado por el
> `cost-cap` deja al conductor recuperando **menos del 100%** de su costo compartido. Las mitigaciones
> (comisión sobre el neto, o un rate de carpool menor) se registran como **Alternativas** (§10) — pero la
> **decisión vigente es comisión-sobre-bruto**, sujeta a validación de legal por país (PE/EC) antes de prod.

### D2 — Riel de desembolso = Yape/Plin a la billetera del conductor, detrás de un PUERTO propio

Se define un puerto NUEVO **`PayoutGateway`** con un método **`disburse(req): Promise<DisburseResult>`**
(money-OUT) — **espejo arquitectónico** del `PaymentGateway` (money-IN), mismo patrón de soberanía
**port + adapter + sandbox** (ADR 012). El dominio del payout habla con el riel SÓLO por este contrato; el
SDK/HMAC/credenciales del PSP viven en el adapter, inyectado por DI.

- **`SandboxPayoutGateway` AHORA**: simulador determinista (confirma la captura por webhook/poll simulado,
  o falla de forma determinista según el monto/seed) → habilita el e2e money-OUT en dev sin PSP real.
- **`YapePlinPayoutGateway` (live) DIFERIDO**: bloqueado por convenio PSP, exactamente como el `charge` live
  del money-IN (ADR 014 §11.3). El puerto + el sandbox + el ciclo de estados se construyen ya; el adapter
  live se enchufa el día del convenio sin tocar el dominio.
- **Sin PII en el payload del riel**: solo IDs (payoutId, driverId) + montos + moneda. La billetera destino
  (walletUid del conductor) la resuelve el adapter server-side, igual que el `resolveActiveWalletUid` del
  money-IN — el dominio NO la porta.

### D3 — Disparo del desembolso = OPERADOR desde el panel admin (el cron NO desembolsa solo)

Se reusa el flujo de hoy con la separación correcta de responsabilidades:

- **El cron semanal AGREGA**: corre `collectEarnings` (filtro `driverId: { not: null }`), crea los Payout del
  período con su `gross/commission/neto`. **El cron ya NO los nace `PROCESSED`**: los crea `PENDING`.
- **El operador DISPARA**: desde el panel FINANCE ejecuta la liquidación (la transición `PENDING → PROCESSING`
  + `disburse`) y **libera los `HELD`**, con **step-up MFA sobre el umbral** (BR-S07, el gate que ya existe
  en `payouts.service.ts:140,296`). El desembolso es un acto humano auditado, no un efecto silencioso del cron.

### D4 — `driverId` wireado (cierra el hueco 1)

`triggerCharge` (`booking-service`) **pasa `driverId`** al `charge()` en AMBOS callers — el path INSTANT del
`reserve` y el `approve` —, resuelto del `trip.driverId` del `PublishedTrip` (ya disponible en el scope, no
hay que buscarlo). El contrato `ChargeInput.driverId?` ya lo acepta (port:43); el Payment deja de nacer
`driverId: null` para el carpooling, y el cobro **entra a la liquidación** por el mismo carril que el
on-demand. Una línea de wiring cierra el CRÍTICO.

### D5 — el ciclo async del desembolso EJERCE los estados existentes (cierra huecos 2, 3 y 5)

`PROCESSED` deja de ser terminal-optimista. El flujo real materializa la máquina ya declarada en `payout.policy.ts`:

```
PENDING ──(operador dispara)──► PROCESSING ──disburse()──► [riel]
                                    │                          │
                                    │           ✓ webhook/poll: captura OK
                                    │                          ▼
                                    │                      PROCESSED   (confirmado: la plata SALIÓ)
                                    │
                                    │           ✗ webhook/poll: riel rechazó / timeout
                                    ▼
                                  FAILED ──(operador reintenta)──► PROCESSING
```

- **`PENDING`**: el cron crea el Payout (agregado, montos calculados). NO se ha movido plata.
- **`PROCESSING`**: el operador dispara → se invoca `PayoutGateway.disburse(req)`. El desembolso es
  **asíncrono** (espejo del CHARGE money-IN): se dispara y se espera el resultado por webhook/poll, no en
  línea.
- **`PROCESSED`** (confirmado): llega la confirmación del riel (`payout.disbursed` / webhook) → la plata SALIÓ.
  **AQUÍ**, y solo aquí, se emite `payout.processed` al outbox y se marca el `paidAt` del incentivo
  (cierra el hueco 5: el bono se marca pagado **recién con el desembolso confirmado**, no antes).
- **`FAILED`**: el riel rechazó o expiró → el operador reintenta (`FAILED → PROCESSING`), idempotente por una
  `dedupKey` derivada del `payoutId` (espejo de la idempotencia financiera del CHARGE, ADR 014 §5.3).
- **`HELD → PROCESSED`**: el operador libera un retenido → entra al mismo ciclo de desembolso (no salta el riel).

Esto **revive los estados muertos** (hueco 3) y resuelve el "marcado pagado sin pagar" (hueco 2 + 5):
ningún Payout llega a `PROCESSED` sin que el riel haya confirmado la salida del dinero.

### D6 — desglose en el panel admin (cierra el hueco 4)

`PayoutView` (admin-bff) y el contrato `payoutView` (api-client) se **amplían** para exponer
`grossCents` / `commissionCents` / `amountCents`(neto) / `processedAt` / `heldReason`. El panel FINANCE pasa
a mostrar **bruto / comisión / neto** + cuándo se procesó + por qué quedó retenido. Es additive (no rompe
consumidores) y da **paridad** con el desglose que el conductor ya ve en su app.

### D7 — notificación al conductor (al confirmar `PROCESSED`)

Al confirmar el desembolso (`PROCESSED`), se emite un push al conductor ("liquidación procesada, S/X en
camino a tu billetera") vía notification-service por su **puerto push existente** (consume `payout.processed`,
que ahora significa "la plata salió de verdad"). **Sin PII en el payload** del evento: solo `payoutId`,
`driverId`, `amountCents`, `period`. La notificación es un consumidor MÁS del `payout.processed`, no un
canal nuevo.

---

## 2. El puerto `PayoutGateway` (money-OUT) — espejo del `PaymentGateway`

El payout adquiere su propio borde de integración, simétrico al del cobro. El dominio del payout NUNCA importa
el SDK del PSP: depende del símbolo DI `PAYOUT_GATEWAY` y un fake del mismo contrato en tests.

```ts
// services/payment-service/src/ports/gateway/payout-gateway.port.ts  (NUEVO — espejo de payment-gateway.port.ts)
import { PaymentMethod } from '@veo/shared-types';

export const PAYOUT_GATEWAY = Symbol('PAYOUT_GATEWAY');

/** Entrada del DESEMBOLSO. Dinero SIEMPRE Int céntimos PEN. SIN PII: el walletUid destino lo resuelve el
 *  adapter server-side desde el driverId (espejo de resolveActiveWalletUid del money-IN). */
export interface DisburseRequest {
  payoutId: string;               // = idempotencia: dedupKey = payout-disburse:{payoutId}
  driverId: string;               // el adapter resuelve la billetera destino; el dominio NO la porta
  amountCents: number;            // NETO a desembolsar (gross - commission)
  method: PaymentMethod;          // YAPE | PLIN (riel money-OUT; live DIFERIDO)
  currency: 'PEN';
}

/** El desembolso nace ASÍNCRONO (PROCESSING → confirma por webhook/poll · §1 D5). El adapter devuelve el
 *  ref externo + el estado inicial; la confirmación final llega por evento, no en línea. */
export interface DisburseResult {
  externalRef: string;
  status: PayoutDisbursementStatus; // SUBMITTED (async) | CONFIRMED (raro síncrono) | REJECTED (permanente)
}

export interface PayoutGateway {
  /** Dispara el desembolso (riel firmado). Idempotente por dedupKey derivada del payoutId. Lanza
   *  ExternalServiceError (transitorio → reintento del operador) o PayoutPermanentlyRejectedError (4xx
   *  no-reintentable → FAILED terminal). */
  disburse(req: DisburseRequest): Promise<DisburseResult>;
}
```

- **`SandboxPayoutGateway`** (AHORA): implementa `disburse` con captura simulada determinista (confirma por un
  webhook/poll simulado, o rechaza según el monto/seed). Habilita el e2e money-OUT en dev. Es el espejo del
  sandbox del CHARGE.
- **`YapePlinPayoutGateway`** (DIFERIDO): el adapter live, bloqueado por convenio PSP. El día del convenio se
  enchufa por DI sin tocar el dominio ni el ciclo de estados.

**Asimetría deliberada con el money-IN**: el CHARGE lo dispara el sistema (al aprobar un booking / completar
un viaje); el DISBURSE lo dispara el **operador** (D3). El riel es asíncrono en ambos (push instantáneo Yape/Plin,
captura por webhook/poll) — por eso ambos tienen estados intermedios (`COBRO_PENDIENTE` money-IN / `PROCESSING`
money-OUT) y confirman por evento.

---

## 3. Ciclo de vida del Payout (la máquina, ahora EJERCIDA)

La policy `payout.policy.ts:79-87` ya describe la máquina; este ADR la pone a correr. El `assertTransition`
es la regla, no el `if`: cada mutación de estado valida contra `PAYOUT_TRANSITIONS` y escribe el evento en la
MISMA transacción (outbox).

| Desde | Evento | Hacia | Invariante / nota |
|---|---|---|---|
| (crear) | cron agrega el período | `PENDING` | `collectEarnings` filtra `driverId: { not: null }`; calcula `gross/commission/neto`. **Cambio: ya NO nace `PROCESSED`** |
| (crear) | cron detecta motivo de hold | `HELD` | flag de retención (rating/disputa/etc.); `heldReason` seteado |
| `PENDING` | operador dispara (step-up MFA · BR-S07) | `PROCESSING` | invoca `PayoutGateway.disburse(req)`; `dedupKey = payout-disburse:{payoutId}` |
| `HELD` | operador libera (step-up MFA) | `PROCESSING` | mismo carril de desembolso (no salta el riel) |
| `PROCESSING` | webhook/poll confirma la salida | `PROCESSED` | **terminal OK**: emite `payout.processed`, marca `paidAt` del incentivo. La plata SALIÓ |
| `PROCESSING` | riel rechaza / timeout | `FAILED` | el dinero NO salió; `paidAt` del incentivo NO se marca |
| `FAILED` | operador reintenta | `PROCESSING` | idempotente por `dedupKey` → no doble-desembolso |

> **`PROCESSED` ya NO se marca en el create**: se marca cuando el riel confirma. El `paidAt` del incentivo
> (`payouts.service.ts:198`) se mueve a ESE punto — del create del Payout al handler de confirmación del
> desembolso. Es el corazón de la corrección "marcado pagado sin pagar".

---

## 4. Eventos (PLAYBOOK §6) — emitidos y consumidos

**Envelope**: UUIDv7 + `<domain>.<pastTense>`. **Outbox**: la mutación de estado y el `INSERT` en outbox van
en la MISMA transacción (atomicidad estado↔evento).

### 4.1 Emitidos (topic `payment`)

| Evento | Cuándo | Cambio vs hoy | Consumidor núcleo |
|---|---|---|---|
| `payout.processing` | `PENDING/HELD → PROCESSING` (operador dispara) | **NUEVO** | audit (traza del disparo humano) |
| `payout.processed` | `PROCESSING → PROCESSED` (riel confirmó la SALIDA) | **semántica corregida**: antes se emitía en el create optimista; ahora solo cuando la plata salió | audit + **notification (push al conductor, D7)** |
| `payout.failed` | `PROCESSING → FAILED` (riel rechazó) | **NUEVO** | audit + notification (avisa al operador) |

### 4.2 Consumidos del riel (la confirmación asíncrona)

El desembolso NO se lee en línea: payment-service **reacciona al webhook/poll** del `PayoutGateway` cuando el
riel resuelve la transferencia (espejo del `applyWebhookResult` del money-IN). El handler corre la transición
`PROCESSING → PROCESSED | FAILED` + (en PROCESSED) marca el `paidAt` del incentivo, todo en una txn atómica.

---

## 5. Acceso (la UI nunca autoriza) — endpoint × riel × rol

Se reusa el carril del panel FINANCE existente (`admin-bff` → payment-service, firmado service-rail). El
desembolso es admin-rail con step-up MFA sobre el umbral (BR-S07).

| Capacidad | Endpoint (forma) | Riel | Rol | Regla server-side |
|---|---|---|---|---|
| Listar liquidaciones del período | `GET /payouts?period` | `admin-rail` | FINANCE | desglose `gross/commission/neto` (§D6) |
| Disparar liquidación (PENDING→PROCESSING) | `POST /payouts/run` | `admin-rail` | FINANCE | step-up MFA si `total > umbral` (BR-S07); invoca `disburse` |
| Liberar retenidos (HELD→PROCESSING) | `POST /payouts/release` | `admin-rail` | FINANCE | step-up MFA; entra al carril de desembolso |
| Reintentar fallido (FAILED→PROCESSING) | `POST /payouts/:id/retry` | `admin-rail` | FINANCE | step-up MFA; idempotente por `dedupKey` |

El cron NO tiene endpoint de desembolso: solo agrega (`PENDING`). El acto de mover plata es siempre humano + auditado.

---

## 6. Integración con servicios existentes (qué reusa, por evento/gRPC)

| Servicio | Cómo se integra | Qué reusa / qué cambia |
|---|---|---|
| **booking-service** | wirea `driverId` en el CHARGE (`triggerCharge`, ambos callers) | el puerto `ChargeInput.driverId?` ya existe (port:43) — solo se pasa el `trip.driverId` ya disponible |
| **payment-service** | dueño del Payout + el nuevo `PayoutGateway` (money-OUT) | reusa `commission()`, `COMMISSION_RATE`, la máquina `payout.policy.ts` (la EJERCE), el step-up MFA (BR-S07), el outbox |
| **PSP (Yape/Plin)** | riel money-OUT detrás del `PayoutGateway` | sandbox AHORA; live DIFERIDO (convenio PSP, como el charge live) |
| **audit-service** | consume `payout.processing/processed/failed` | ya consume `payout.processed` (`audit.consumer.ts:194`); se le suman los dos nuevos |
| **notification-service** | consume `payout.processed` → push al conductor (D7) | su puerto push existente; sin PII en el payload |
| **admin-bff** | `toPayoutView` amplía el desglose (D6) | `finance.service.ts:118-126` + contrato `payoutView` (`api-client/types.ts:205`) |

---

## 7. Idempotencia financiera del desembolso

El DISBURSE lleva **`dedupKey = payout-disburse:{payoutId}`** (espejo del `booking-charge:{bookingId}` del
CHARGE, ADR 014 §5.3, y distinta de él para no colisionar). Reintentos del mismo Payout (`FAILED → PROCESSING`)
→ la misma key → el riel NO duplica la transferencia. Esto vuelve **seguro el reintento manual del operador**:
re-disparar un payout fallido nunca paga dos veces.

---

## 8. Caminos infelices (PLAYBOOK §5.3) — el "¿y si…?"

| ¿Y si…? | Resultado de diseño |
|---|---|
| el `disburse` falla (riel rechaza / timeout) | `PROCESSING → FAILED`. La plata NO salió; el `paidAt` del incentivo NO se marca; el operador reintenta (`FAILED → PROCESSING`, idempotente por `dedupKey`). |
| doble-click del operador al disparar | `assertTransition` rechaza el 2º `PENDING→PROCESSING`; el `disburse` lleva `dedupKey` → el riel no duplica. |
| webhook duplicado del riel (misma confirmación 2×) | el handler es idempotente: `assertTransition` ya en `PROCESSED` rechaza la 2ª transición; el `paidAt` ya marcado no se re-marca. |
| total del run supera el umbral, operador sin MFA fresca | `ForbiddenError` (BR-S07, `payouts.service.ts:140,296`) — el desembolso masivo exige step-up MFA. |
| cobro de carpooling con `driverId` ausente (app vieja pre-wiring) | el Payment nace `driverId: null` → queda fuera del payout (filtro `not: null`). Es el comportamiento de hoy; el wiring (D4) lo cierra hacia adelante. NO se inventa un payout sin conductor. |
| el adapter live no está (convenio PSP pendiente) | el sandbox confirma de forma determinista en dev; en prod sin adapter live el disparo falla-rápido (no hay silencio): el operador no puede desembolsar lo que el riel no soporta aún. |
| el conductor recupera menos que su costo compartido (cost-cap) | **tensión REAL del modelo cost-sharing** (§11.2) — NO es un bug del payout: es la consecuencia de comisión-sobre-bruto (D1). Registrado como follow-up que legal valida por país antes de prod. |

---

## 9. Consecuencias

### 9.1 Positivas

- **El conductor cobra de verdad**: `PROCESSED` significa "la plata salió", no "se marcó una fila". El riel
  está detrás de un puerto soberano, con sandbox para e2e y live diferido sin tocar el dominio.
- **Carpooling entra a la liquidación**: una línea de wiring (`driverId`) cierra el CRÍTICO #1; el cobro del
  asiento se liquida por el MISMO carril que el on-demand.
- **Estados vivos**: `PROCESSING`/`FAILED` dejan de ser muertos — la máquina declarada se ejerce.
- **Sin bono-perdido**: el `paidAt` del incentivo se ata al desembolso confirmado, no al create optimista.
- **Panel FINANCE auditable**: bruto/comisión/neto visibles; paridad con la app del conductor.
- **Soberanía money-OUT**: `PayoutGateway` espeja al `PaymentGateway` — un patrón conocido en el repo, no uno nuevo.

### 9.2 Negativas / costo + el riesgo legal a registrar

- **Tensión cost-sharing ↔ comisión-sobre-bruto (D1) — RIESGO A VALIDAR POR LEGAL (PE/EC) ANTES DE PROD.**
  El `cost-cap` (`services/booking-service/src/domain/cost-cap.ts:63-77`) topa el precio del asiento a
  `floor((distanceKm × costPerKmCents) / asientosTotales)` — es decir, ≤ (costo real / asientos), la promesa
  "cost-sharing, sin lucro". Aplicar `COMMISSION_RATE` (20%) **sobre ese bruto** deja al conductor recuperando
  `precioAsiento × (1 − rate)` → **menos del 100% de su costo compartido**. Es una tensión legal/de-producto
  **real**: en un esquema cost-sharing puro el conductor no debería perder plata por compartir. **Decisión
  vigente: comisión-sobre-bruto** (D1, espejo del on-demand). **Follow-up obligatorio: legal valida por país
  (PE/EC) antes de prod**; las mitigaciones (comisión sobre el neto, o un rate de carpool menor) están en §10.
- **Riel live pendiente**: el desembolso real en prod espera el convenio PSP (como el charge live). Hasta
  entonces, sandbox en dev y disparo fallando-rápido en prod (no silencio).
- **Más eventos/handlers**: `payout.processing/failed` nuevos + el handler de confirmación del riel (webhook/poll).
- **Acto humano**: el operador es el cuello de botella del desembolso (decisión D3 — auditable, no silencioso).

---

## 10. Alternativas consideradas

- **Comisión de carpooling sobre el NETO (post cost-cap)** — pros: el conductor recupera el 100% de su costo
  compartido, sin tensión legal. Contras: rompe el espejo exacto con el on-demand (dos fórmulas de comisión),
  y reduce el take de VEO. **No elegida** (D1 = espejo on-demand), pero es la **mitigación #1** si legal objeta.
- **Rate de comisión de carpool menor (`COMMISSION_RATE_CARPOOL` < 20%)** — pros: suaviza la tensión sin
  romper la fórmula. Contras: un segundo rate que mantener/configurar por país. **No elegida**, registrada como
  **mitigación #2**.
- **Cron desembolsa solo (sin operador)** — pros: cero fricción humana. Contras: mover plata sin un acto
  humano auditado + step-up MFA es un riesgo operativo/de-fraude inaceptable. **Rechazada** (D3): el cron
  agrega, el humano desembolsa.
- **`PROCESSED` síncrono (leer la captura en línea)** — pros: simple. Contras: el riel Yape/Plin es push
  asíncrono (captura por webhook/poll, como el money-IN) — leer en línea sería una mentira. **Rechazada**:
  estados intermedios + confirmación por evento (D5), espejo del CHARGE.
- **`disburse` en el `PaymentGateway` existente** — pros: un puerto menos. Contras: mezcla money-IN y money-OUT
  en un contrato, rompe la simetría y el mínimo privilegio (un adapter de cobro no debería poder desembolsar).
  **Rechazada**: puerto `PayoutGateway` separado (D2).
- **Exponer gross/commission por un endpoint aparte** — pros: no toca `payoutView`. Contras: dos llamadas para
  una vista, des-sincronía. **Rechazada**: ampliación additive del `payoutView` (D6).

---

## 11. Qué se difiere (degradación honesta)

| Diferido | Por qué fuera de este ADR |
|---|---|
| **Adapter LIVE de Yape/Plin payout** | bloqueado por convenio PSP (igual que el charge live, ADR 014 §11.3). El puerto + sandbox + ciclo de estados se construyen ya. |
| **Reembolso por tiers de cancelación** | es dominio de `booking-service` (F3/F5), no del payout. El payout consume `booking.completed`/cobros CAPTURED, no gestiona refunds. |
| **PUJA en carpooling** | F6 (ADR 010/014). El payout es agnóstico al modo de pricing: liquida el cobro CAPTURED, venga de FIJO o PUJA. |
| **Validación legal del cost-sharing por país** | tracking de producto/legal (§9.2), no una decisión de arquitectura — pero **bloquea prod** para carpooling. |

---

## 12. Anatomía del cambio (dónde aterriza, por servicio)

```
payment-service/
├── src/
│   ├── ports/gateway/
│   │   ├── payment-gateway.port.ts          # money-IN (existe; charge/getStatement/refund)
│   │   └── payout-gateway.port.ts           # money-OUT (NUEVO: disburse + PAYOUT_GATEWAY)        ← §2
│   ├── adapters/gateway/
│   │   ├── sandbox-payout-gateway.ts        # simulador determinista (AHORA)                      ← D2
│   │   └── yape-plin-payout-gateway.ts      # adapter live (DIFERIDO, convenio PSP)               ← D2
│   ├── payouts/
│   │   ├── payouts.service.ts               # cron crea PENDING (no PROCESSED); operador dispara;
│   │   │                                    #   handler de confirmación: PROCESSING→PROCESSED/FAILED,
│   │   │                                    #   marca paidAt del incentivo SOLO en PROCESSED       ← D3/D5
│   │   ├── payout.policy.ts                 # máquina YA declarada (79-87) — ahora EJERCIDA        ← hueco 3
│   │   └── payout-disbursement.handler.ts   # consume webhook/poll del riel → txn atómica          ← §4.2
│   └── payments/payments.service.ts         # Payment.driverId entra cuando booking lo wirea       ← D4
│
booking-service/
└── src/bookings/bookings.service.ts         # triggerCharge pasa driverId=trip.driverId (×2 callers) ← D4/hueco 1
│
admin-bff/
└── src/finance/finance.service.ts           # toPayoutView amplía gross/commission/neto/processedAt/heldReason ← D6/hueco 4
│
api-client/
└── src/types.ts                             # payoutView additive: gross/commission/neto/processedAt/heldReason ← D6
│
notification-service/                        # consume payout.processed → push al conductor (sin PII)  ← D7
└── audit-service/                           # ya consume payout.processed; +processing/+failed         ← §4.1
```

---

## 13. Referencias

- ADR 010 (puja) · ADR 012 (métodos de auth soberanos — patrón port+adapter+sandbox) · ADR 013 (catálogo/pricing) ·
  ADR 014 (carpooling `booking-service` — CHARGE money-IN async, charge-on-approval, idempotencia financiera).
- Evidencia de los huecos (verificada 2026-06-25):
  - `services/booking-service/src/bookings/bookings.service.ts:581` (charge sin `driverId`) ·
    `:249,262,328-357` (callers con `trip.driverId` disponible) ·
    `services/booking-service/src/ports/payment/payment-gateway.port.ts:43` (`ChargeInput.driverId?` ya soportado)
  - `services/payment-service/src/payments/payments.service.ts:267` (`driverId ?? null`)
  - `services/payment-service/src/payouts/payouts.service.ts:353` (filtro `not: null`) ·
    `:187,203,212` (PROCESSED + `payout.processed` al outbox) · `:198` (paidAt del incentivo en la tx) ·
    `:140,296` (step-up MFA BR-S07)
  - `services/payment-service/src/payouts/payout.policy.ts:79-87` (máquina con estados muertos)
  - `services/payment-service/src/ports/gateway/payment-gateway.port.ts:144-161` (sin `disburse`)
  - `services/audit-service/src/consumers/audit.consumer.ts:194` (único consumidor de `payout.processed`)
  - `services/bff/admin-bff/src/finance/finance.service.ts:118-126` (`toPayoutView` opaco) ·
    `packages/api-client/src/types.ts:205-212` (contrato `payoutView` sin desglose)
  - `services/payment-service/prisma/schema.prisma:204-205` (`gross_cents`/`commission_cents` persistidos)
  - `services/booking-service/src/domain/cost-cap.ts:63-77` (tope cost-sharing) ·
    `services/payment-service/src/config/env.schema.ts:33` (`COMMISSION_RATE` default 0.2)

---

_Decisión: el payout DESEMBOLSA de verdad — `PayoutGateway` money-OUT (puerto soberano, sandbox AHORA / live
DIFERIDO), disparado por el OPERADOR con step-up MFA; el ciclo `PENDING → PROCESSING → PROCESSED | FAILED`
EJERCE la máquina ya declarada; `PROCESSED` confirmado = la plata salió (ahí se emite `payout.processed`, se
notifica al conductor y se marca el bono); el carpooling entra a la liquidación wireando `driverId` en el
CHARGE; el panel FINANCE expone bruto/comisión/neto. Comisión carpooling = sobre el bruto (espejo on-demand),
con la tensión cost-sharing registrada como riesgo legal a validar PE/EC antes de prod. Live Yape/Plin,
refunds por tier y PUJA quedan fuera de scope. Próximo: lotes de construcción (§12) vía /abordar._
