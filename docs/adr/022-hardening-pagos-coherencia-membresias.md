# ADR 022 — Hardening del flujo de pagos: coherencia del dinero + membresías (conductor + pasajero)

> Estado: **PROPUESTO** (plano · dirige la obra). Fecha: 2026-07-02.
> Consolida el audit exhaustivo del money flow (3 rondas · ~9 Explore agents · docs oficiales ProntoPaga ·
> verificado nivel 1). El motor CORE es sólido (integer cents, split sin drift, comisión-por-modo
> benchmarkeada inDrive/BlaBlaCar, RBAC server-gated + step-up MFA, webhooks HMAC + idempotencia). Los
> problemas son: **3 fugas de dinero**, **1 hueco de coherencia contable (fee PSP)**, inconsistencias de
> monto/UI, y **2 features de negocio sin construir (membresías)**. Refina ADR-013/014/015 (finanzas).

## 0. Principio rector (el "flow correcto")

**Cada peso tiene que cuadrar en 3 planos:** (1) lo que el PASAJERO ve/acuerda = lo que se cobra; (2) lo que
la PLATAFORMA registra = lo que llega al banco (neto de fee PSP); (3) lo que el CONDUCTOR gana = lo que se
le liquida. Hoy los 3 divergen. Regla: **dinero en enteros, un solo funnel de tasa, el fee PSP es un pasivo
MODELADO (no silencioso), y la UI refleja — nunca inventa un número que el server no cobró.**

**Moneda (DECISIÓN 2026-07-02, reconciliación specs↔docs #2 · opción A):** el contrato de dinero es el value-object
**`Money { amountCents, currency }`**, con `currency` **OBLIGATORIA en TODO campo de dinero del dominio** (no solo los
nuevos de este ADR). Hoy la única moneda operada es PEN; la activación EC/USD es F8, pero el contrato ya lleva el tag
para **no migrar el dominio dos veces**. **P-B se amplía:** además de crear los campos nuevos ya tagueados (pspFeeCents,
netSettled, DriverDebt, plan fees), **migra los existentes** (`fareCents`, `tipCents`, `amountCents`, …) al value-object.
Un solo funnel de tasa + un solo de moneda.

## 1. Estado ACTUAL verificado (lo que YA está bien — no romper)

- Split integer-safe: `money()` tira en no-enteros; `commission()=Math.round(gross×rate)`; net por resta → `commission + net == gross + tip` siempre.
- Comisión por MODO (payment.policy.ts): ON_DEMAND (inDrive) = comisión DESCONTADA al conductor; CARPOOLING (BlaBlaCar) = service fee SUMADO al pasajero, conductor 100%. `ChargeMode` = {ON_DEMAND, CARPOOLING} (no hay modo PUJA: FIXED y PUJA comparten `onDemandRateBps`).
- `CommissionConfig` singleton admin-editable per-mode (RBAC FINANCE + step-up MFA + CAS + outbox).
- Webhooks ProntoPaga HMAC-SHA256 timing-safe + capture idempotente CAS + reorder-tolerant; charge idempotente por `dedupKey`.
- 5 métodos: YAPE (default), PLIN, CASH, CARD, PAGOEFECTIVO. Digital → cuenta de la EMPRESA (ProntoPaga comercio) → payout al conductor; CASH → conductor en mano.

## 2. Hallazgos → FASES del plan (severidad · evidencia)

### 🔴 Fase P-A — Las 3 FUGAS de dinero (CRÍTICAS · money real)
- **A1 · Propina digital nunca se cobra. ✅ HECHO (Model B).** El `addTip` viejo solo creaba `TipAddition` + incrementaba `tipCents/amountCents` en un pago YA CAPTURED + emitía evento — **sin `gateway.charge`**. El conductor SÍ la recibía en el payout → la plataforma subsidiaba el 100%.
  - **Decisión del dueño (2026-07-02 · Model B, reconcilia la contradicción ADR↔app):** el borrador decía "para CASH marca 'propina en mano' sin payout digital" — pero el copy del app pasajero (`tipPromptCash`) ya promete _"en viaje efectivo la propina por estos chips se cobra DIGITAL"_. La rama "en mano" habría PERDIDO la propina (el pasajero toca un chip esperando cobro, el conductor no recibe nada). **Model B: TODA propina iniciada en el app se COBRA DIGITAL.**
  - **Implementado (backend):** `addTip` crea un cobro DEDICADO (**tip-Payment `kind=TIP`**, gross 0, comisión 0, 100% al conductor · nuevo `enum PaymentKind {FARE|TIP}` + migración) que pasa por el MISMO despacho digital que la tarifa. El MÉTODO = el de la tarifa si fue digital; si el viaje se pagó en EFECTIVO cae a **YAPE por defecto** (`DEFAULT_DIGITAL_TIP_METHOD` · on-file si hay afiliación, si no checkout QR — el gateway no cobra CASH). El conductor la cobra SOLO al CAPTURAR: `captureSuccess` emite `payment.tip_added` (no `payment.captured`) y el `tipCents` entra al payout (`collectEarnings` ya lo agrega). Idempotente por `Payment.dedupKey` (`tip-charge:`).
  - **El gate `auditar-core` (3 rondas, ~80 agentes) cazó que el tip-Payment se filtraba en TODO lookup que asumía "un payment = una tarifa" — TODOS cerrados (con tests):** (1) 🔴 refund by-trip → `kind=FARE` · (2) 🔴 **gate de deuda del pasajero** (`getDebtForPassenger` DEBT+PENDING) → `kind=FARE` (una propina fallida NO bloquea viajes) · (3) 🔴 **`markDebt` kind-aware** (propina que DECLINA → `FAILED` terminal SIN `payment.failed`) · (3b) 🔴 **`markFailed` kind-aware** (propina cuyo checkout EXPIRA — el caso más común — → `FAILED` SIN `payment.failed`, para no alertar a seguridad ni pushear "pago falló") · (4) 🟠 `earningsForDriver` → `tripCount` cuenta solo `FARE` (la propina suma en `tipCents`, no como viaje). **Re-auditoría sistémica de los ~25 lookups de payment:** los de agregación de dinero (payouts `collectEarnings`, reconciliation, poll) INCLUYEN el tip correctamente; los by-id/uid/dedupKey son seguros. tsc ×3 capas + 9 tests A1 + suite 450 verde.
  - **App-side (apps/passenger) — HECHO:** el `TipCard` usa el clasificador canónico `interpretPaymentOutcome` → `settled`="enviada" · `checkoutPending`=render `CheckoutInstructions` (QR/Yape/CIP, `onRetry` re-corre el cobro idempotente) · `processing`="en proceso" · `failed`→reset al selector. El BFF `enrichTripDetail` puebla `tipCents` desde `GetPaymentByTrip` (que agrega Σ tip-Payments capturados) → la confirmación persiste al re-montar, no re-propina.
  - **Refund del tip — HECHO (best-effort):** un refund TOTAL del viaje reembolsa las propinas digitales capturadas + CANCELA (CAS PENDING→FAILED) las PENDING para que un webhook tardío no las capture (`refundTripTipsFully`, idempotente `tip-refund:<id>`, NUNCA aborta el refund de la tarifa; los fallos van a `logger.error` para alerta/reconciliación).
  - **Residuales MEDIA de A1 (gate #3, no ALTA) → follow-up `reconciliation backstop`:** el `refundTripTipsFully` síncrono tiene bordes de carrera — (i) TOCTOU: una propina creada/capturada en la ventana exacta de un refund total concurrente; (ii) async-ordering: el reverso digital de la tarifa es async (PENDING) y podría rechazarse DESPUÉS de reembolsar la propina. La forma ROBUSTA (race-free, retryable) es un **backstop de reconciliación** que barre propinas CAPTURED sobre viajes REFUNDED y las reembolsa — se construye como cierre de A1 (mismo patrón "reconciliar" que ADR-017 §refund). + `collectEarnings`/`earningsForDriver`: índice `(driverId, status, capturedAt)` (perf, P-D).
- **A2 · CASH double-pay. ✅ HECHO (DriverDebt + netting).** `collectEarnings` seleccionaba `CAPTURED + driverId` **sin filtro `method`** → un viaje CASH (conductor ya cobró en mano) generaba un payout bancario positivo + la plataforma nunca cobraba su comisión.
  - **Implementado (decisión del dueño: DriverDebt + netting):** (1) nuevo **ledger `DriverDebt`** (`enum PaymentKind`-style, idempotente por `paymentId`, estados PENDING/SETTLED/REVERSED) — en `captureCash` (el punto ÚNICO de captura CASH bilateral, usado por `confirmCash` Y `applyDriverCashConfirmation`), si hay comisión>0 se acumula `DriverDebt = commissionCents` DENTRO de la tx de captura (atómico). (2) `collectEarnings` excluye `method=CASH` del payout positivo (los tip-Payments digitales de un viaje cash SÍ entran). (3) `executePayoutRun` netea la deuda PENDING contra la ganancia digital (`applyDebtNetting`, FIFO, cubre enteras + reduce la del borde = carry-forward, dentro de la tx; el payout paga el neto, `Payout.debtAppliedCents` audita). Es el flujo INVERSO del dinero, explícito.
  - **El gate cazó (cerrado):** 🔴 **el refund de un viaje CASH no revertía la deuda** → el conductor quedaba sobre-cobrado la comisión de un viaje revertido. **Fix:** `reverseCashDebtInTx` en `refundCashLocally` (atómico) — reduce la deuda PENDING por lo reembolsado; a 0 → `REVERSED`. + 🟠 aislamiento de error **por-conductor** en el run (un driver que falla no aborta el run entero, self-healing). Verificado: tsc + 10 unit tests A2 + 2 e2e real-DB (accrual + netting run).
  - **Residuales MEDIA (no ALTA) → follow-ups:** (i) **deuda huérfana**: un conductor solo-CASH (o con digital < `PAYOUT_MIN_CENTS`) nunca netea → su comisión no se cobra (fuga a favor del conductor) — necesita un mecanismo de cobro directo/carry para cash-only. (ii) **SETTLED al crear** el payout (PENDING) y no al confirmarse (PROCESSED): un payout abandonado deja la deuda SETTLED sin desembolso — alinear con el patrón de bonos de ADR-015 (marcar al confirmar). (iii) **credit-back**: un refund CASH sobre una deuda ya SETTLED (neteada en un payout previo) no se devuelve al conductor.
- **A3 · `changeDestination` baja el fare PUJA por debajo del bid acordado.** (trips.service.ts:1717-1740) recomputa con la fórmula FIXED **sin piso** vs el hermano `waypoint-proposal.service.ts:218` que sí pone `Math.max(policyFare, trip.fareCents)`. **Fix:** flooreá `changeDestination` al `trip.fareCents` acordado para PUJA (o bloqueá el re-quote hacia abajo de una tarifa negociada); + "el precio cambió, reconfirmá" si sube.

### 🟠 Fase P-B — Coherencia contable: el FEE de ProntoPaga (ALTA · libros ≠ banco)
- **B1 · El fee PSP no se modela. 🚧 Lote 1 HECHO.** El webhook manda `amount`=gross sin fee/net; el fee se netea en la Liquidación de ProntoPaga (un REPORTE del portal, NO una API — verificado en sus docs) que VEO no ingesta → los libros divergen del banco por el fee.
  - **Investigación (docs oficiales ProntoPaga, §7):** el fee **NO lo expone la API/webhook** (es comercial, del convenio) + **varía por método** (los SLAs son por método/país). Por eso el fee se **MODELA** en VEO + se reconcilia contra el reporte (gated).
  - **Lote 1 (hecho, decisión del dueño: tarifa EDITABLE):** (a) `pspFeeCents` + `netSettledCents` (nullable) en `Payment` + migración. (b) Fee **por método, EDITABLE por admin** en `CommissionConfig` (`{yape,plin,card,pagoefectivo}FeeBps`, arranca en **0** = degradación honesta; el dueño carga la tarifa del convenio después, sin deploy). (c) En la captura se computa `pspFee = round(amount × bps)`, `net = amount − fee` y se persisten (CASH → fee 0, net = amount). (d) KPI `revenueToday` **net-aware** (usa `netSettledCents`, la plata REAL que entra; el bruto queda como throughput). Verificado: tsc + tests policy + suite 305 unit + e2e real-DB (migración + población).
  - **Lote 2 (hecho):** (a) `reconciliation.reconcile` lado DB usa `Σ netSettledCents` (COALESCE al bruto en legacy) — antes comparaba bruto vs extracto → divergía por el fee. (b) KPI `platformMarginToday` = `Σ comisión − Σ fee PSP − Σ promo − Σ crédito`. (c) admin **PUT `internal/finance/psp-fee`** (`replacePspFees`, CAS por version, guards FINANCE + step-up MFA, read-your-writes) → el dueño edita la tarifa del convenio.
  - **El gate (86 agentes) cazó 2 ALTA — cerrados:** (1) 🔴 `revenueToday`/`platformMarginToday` incluían **CASH** → el efectivo lo cobra el conductor EN MANO, nunca llega al banco de VEO → inflaba el KPI "neto al banco". **Fix:** los 3 KPIs (revenueToday, margin, revenuePerHour) **EXCLUYEN CASH** + son net-aware coherentes. (2) 🔴 un webhook **CONFIRMED sobre un pago en DEBT** no capturaba (CAS solo `status=PENDING`) pero retornaba "CAPTURED" en falso → plata capturada en el PSP, VEO en DEBT. **Fix:** el CAS de `captureSuccess` incluye `DEBT` (DEBT→CAPTURED válido). + MEDIA: read-your-writes del PUT, `revenuePerHour` net-aware coherente, `PARTIALLY_REFUNDED` en el KPI. Verificado: tsc + 312 unit + analytics test + 2 e2e real-DB.
  - **Residuales (no ALTA) → follow-up:** índice `(status, method, capturedAt)` para los KPIs (perf) · el PUT `psp-fee` necesita el proxy admin-bff + UI admin-web para ser usable end-to-end · una captura durante un outage de `getConfig` persiste `pspFee=0`/`net=amount` (honesto, lo corrige el ingest de Liquidación) · `replacePspFees` sin outbox (propagación cross-réplica por TTL 10s, drift consciente vs `replace`).
  - **GATED al convenio (follow-up):** ingerir el reporte de Liquidación de ProntoPaga (import CSV) → reconciliar el fee MODELADO vs el REAL por transacción. Sin el convenio + el formato del reporte, no se puede (mismo patrón que money-OUT G1).
- **B2 · KPI de recaudación inflado** por el fee no descontado (analytics.service:64 suma `amountCents` gross). **Fix:** el KPI de "money-in real" usa `netSettled`; el gross queda como "throughput".

### 🟠 Fase P-C — Consistencia del MONTO (quote → agreed → cobro) (ALTA)
- **C3 · Rounding + double-source de la FÓRMULA. 🚧 Lote 1 HECHO.** La raíz de P-C: había DOS calculadoras de tarifa fija (el quote en `public-bff/maps/fare.ts` y el cobro firme en `trip-service/domain/fare.ts`) que divergían — el quote redondeaba a S/0.10 y OMITÍA surge/niño; el firme redondeaba al céntimo e incluía surge. El pasajero veía un número y se le cobraba otro.
  - **Decisiones del dueño:** (1A) redondeo a **S/0.10 en TODO** (quote y cobro); (2A) umbral de reconciliación (Lote 2) = **S/0.10** (un paso).
  - **Lote 1 (hecho):** (a) FUENTE ÚNICA `computeFixedFareCents` en `@veo/shared-types` (leaf, sin ciclo con `@veo/utils`) — la consumen el quote (BFF), el create FIXED, `changeDestination` y `waypoint-proposal` → paridad de fórmula por CONSTRUCCIÓN, cero double-source. (b) Redondeo S/0.10 con minFare aplicado DESPUÉS del redondeo (evita violar el piso con minFare admin no-múltiplo-de-10). (c) **surge server-authoritative en el QUOTE** (mismo `dispatch.getSurge` que el create, solo FIXED, fail-safe 1.0): el pasajero VE el precio surgeado que se le va a cobrar → cierra el sobrecobro SILENCIOSO. Verificado: tsc + trip-service 545 + shared-types 81 + public-bff 262 + 2 gates adversariales.
  - **El gate (2 rondas) cazó y se cerró:** 🔴 **regresión propia** — un intento inicial forzó el surge del cobro a 1.0 (mató ADR-021 §C); revertido. 🔴 **audit-log** de `changeDestination` grababa el fare CRUDO mientras cobraba el redondeado (Ley 29733 mentía ±S/0.10) → audita el `fareCents` real. 🟠 double-source residual (changeDest/waypoint seguían en la fórmula vieja) → unificados. 🔴 **sobrecobro silencioso surge** (quote sin surge, cobro con surge) → surge en el quote.
  - **Residuales / follow-up:** el flip-ON del modelo de energía NO está unificado (quote V2 sin surge vs create V2 con surge) — inerte hoy (flip OFF), unificar en el mismo acto del flip. RangeError de la fn compartida → HTTP 500 (los inputs son server-controlled/DTO-validados; defensa en profundidad).
- **C1 · Persistir `quotedFareCents` + reconciliar. → Lote 2.** El cobro es re-cómputo del server (CUMPLE); falta persistir el monto que el pasajero confirmó y reconciliar contra el recompute (si difiere > S/0.10 → reconfirmación, no cobro silencioso). Cierra el residual de surge-drift entre quote y confirmación. + quote **child-aware** (hoy el quote omite el recargo niño; la app lo muestra aparte en el desglose, no es silencioso, pero el handshake debe incluirlo).
- **C2 · QUOTE vs BID disconnect** (el tier muestra tarifa fija ~26; PUJA cobra el bid proponés desde piso ~20). **Fix (UX):** dejar claro que en PUJA el tier es REFERENCIA y vos ponés tu precio; el "vas a pagar X" del bid manda. → Lote 3 (copy).
- **Flageados (pre-existentes, NO de P-C — decisión del dueño):** (i) 🔴 `changeDestination` re-cotiza con el pricing del catálogo de CÓDIGO, no el overlay EFECTIVO del admin (create sí usa el efectivo) → incoherencia de pricing create↔changeDest. (ii) 🔴 `changeDestination` NO exige el código de modo niño (el spec lo pide como moat de seguridad; hoy solo se valida en `startTrip`).

### 🟠 Fase P-D — Admin finance que CUADRE (ALTA)
- **D1 · Liquidaciones no cuadra:** la tabla muestra Bruto/Comisión/Neto pero `Neto = gross − comisión + propina + bonos` sin columna → `Neto ≠ Bruto − Comisión`. **Fix:** agregar columnas Propinas + Bonos a `PayoutView` + la tabla (o desglose del "extra neto").
- **D2 · Sin superficie pre-liquidación:** un viaje completado (cobrado) no tiene fila en admin hasta el batch semanal → el admin no puede reconciliar el momento. **Fix:** vista de "ganancias devengadas / por liquidar" que agrega los CAPTURED en vivo (como el breakdown del conductor), no solo los payouts.
- **D3 · "Neto S/0.00" del conductor:** el home lee payouts (batch semanal), el breakdown lee CAPTURED en vivo → 2 números. **Fix:** el home muestra el devengado (por liquidar) de los CAPTURED, no el payout vacío.
- **D4 · Desglose carpool del conductor MIENTE:** `earningsForDriver`+`BreakdownCard` suman `commissionCents` cross-mode → en carpool muestran bruto inflado (contribución + fee del pasajero) + "comisión −X" fantasma. **Fix:** agregación mode-aware; en carpool mostrar "contribución (100%)" sin línea de comisión.

### 🟠 Fase P-E — Membresía del CONDUCTOR (reduce comisión) — FEATURE NUEVA
Benchmark: Empower $50/mes→0%, Bolt/inDrive pilots $100-200/mes→100%, inDrive baja % dinámico por surge.
- **Modelo:** nuevo `DriverCommissionPlan { driverId, planTier, onDemandDiscountBps | flatRateBps, activeUntil }` en payment-service (mismo contexto "dinero").
- **Integración (un solo seam):** threadear `driverId` por el ÚNICO funnel `resolveChargeRate(mode, driverId)` → `commission.resolveRateBps(mode, driverId)` → `resolveCommissionBps(mode, config, driverOverrideBps?)`. Sin plan activo → cae al `CommissionConfig` global (cero cambio de comportamiento). **GATED a ON_DEMAND** (en carpooling el conductor ya cobra 100%, no hay qué bajar).
- **Billing del plan:** cobro recurrente vía el rail Yape On-File (`affiliations/`) o descuento en la liquidación semanal (`driver-payments`). Membresía = plan∩rol (MENTORIA): el gate del descuento vive server-side en la resolución de tasa, la UI solo refleja.
- **Admin:** panel para definir tiers + su descuento; reporte de adopción.

### 🟠 Fase P-F — Membresía del PASAJERO — FEATURE NUEVA
Benchmark: Uber One (6% cashback + surge relief), Cabify Club (priority + loyalty).
- **Oferta COHERENTE (nunca achica el corte del conductor):** (a) waive/reduce el **carpooling service fee** (es revenue de la plataforma) — hook en `resolveCommissionBps`/`discountCents`; (b) descuentos on-demand **absorbidos por la plataforma** vía el rail promo/credit EXISTENTE (`discountCents`/`PromotionsService`/`CreditService` ya en `charge()`); (c) **priority dispatch** (hook en dispatch, sin acoplar dinero); (d) cashback vía `CreditService`.
- **Prerequisito:** cerrar P-H (el carpool no tiene UI de pasajero → un beneficio "fee carpool waived" no tiene dónde mostrarse).
- **Billing:** cobro recurrente (nuevo concern en payment-service).

### 🟡 Fase P-G — Money-OUT (payout real al conductor)
- **G1 · El riel de desembolso está DIFERIDO** (yape-plin-payout.gateway `isAvailable()=false` + `disburse()` throws; ADR-015 D2 convenio PSP pendiente) — fail-fast honesto, NO bug, pero **nadie cobra su payout en prod hasta firmar el convenio**. **Fix (cuando el convenio esté):** activar el adapter live + verificar firma del gateway de payout.
- **G2 · No hay modelo de cuenta-destino del conductor** (WalletAffiliation es del pasajero para COBRAR). **Fix:** modelo `DriverPayoutAccount { driverId, method (YAPE|PLIN), walletUid, verified }` + verificación (evitar plata al destino equivocado). Payout method per-driver (hoy hardcoded YAPE).

### 🟡 Fase P-H — Superficie de carpool del PASAJERO (prereq de P-F)
- El carpool hoy es driver-only (no hay feature en `apps/passenger`, no hay booking controller en public-bff). **Fix:** public-bff booking/reserve controller + feature `carpool` en el pasajero (quote "contribución + service fee" transparente → reservar → cobrar por SERVICE_RAIL). Entrega la transparencia que el modelo ya soporta.

### 🟢 Bajas
Idempotency-key del cliente decorativa (server dedup OK) · read-model staleness admin (money-safe por CAS) · commission degradado mostrado sin banner.

## 3. Orden de ataque recomendado
1. **P-A** (las 3 fugas — money real que se pierde/cobra mal HOY).
2. **P-B** (coherencia contable PSP — libros ≠ banco, riesgo financiero silencioso).
3. **P-C + P-D** (consistencia monto + admin que cuadre — lo que el dueño VE).
4. **P-E** (membresía conductor — feature de negocio + retención).
5. **P-H → P-F** (carpool pasajero + membresía pasajero — expansión).
6. **P-G** (money-OUT — gated al convenio PSP; sin esto no hay payout real).

## 4. Verificación (cada fase)
tsc + tests + `auditar-core` (scope de la fase, eje código-vs-plan) + BOOT-REAL del dinero (cobro→split→
payout→admin cuadran). Regla: una fase de dinero NO se entrega sin que los 3 planos (pasajero/plataforma/
conductor) cuadren contra la DB en runtime. Integer cents siempre; cero strings mágicos (enums de modo/
método/estado tipados).

## 5. Decisiones que necesita el DUEÑO (antes de construir cada fase)
- **P-A2 (cash):** ¿DriverDebt (el conductor debe la comisión, se netea del payout) o excluir cash del payout y cobrar la comisión aparte? (recomendado: DriverDebt + netting).
- **P-E:** ¿el plan del conductor es flat-fee→descuento-de-%, o %-reducido-por-tier? ¿aplica a FIXED y PUJA por igual (hoy comparten rate) o hay que separarlos?
- **P-F:** ¿qué ofrece el plan del pasajero exactamente (waive carpool fee / cashback / priority / combo)? ¿precio?
- **P-B:** ¿el fee PSP lo absorbe la plataforma (modelo actual implícito) o se traslada (recargo al pasajero en digital, cash sin recargo)? — decisión de negocio.
