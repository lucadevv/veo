# ADR 018 — Verificación de identidad del pasajero: PROGRESIVA (badge de confianza), no muro pre-viaje

> Estado: **IMPLEMENTADO** (Lotes 1-4 en código, verificados). Fecha: 2026-07-01.
> - **Lote 1** (`4c3d67d1`): estado inicial UNVERIFIED + retiro del gate de `POST /trips`. tsc + 176 tests + auditar-core + boot-real.
> - **Lote 2** (`bfd6cfc8`): migración 49 pasajeros PENDING → UNVERIFIED (conteos verificados).
> - **Lote 3** (`6e01a968`): app — `KycGate` fuera de la cotización. tsc + **boot-real E2E: el pasajero UNVERIFIED pidió sin muro**.
> - **Lote 4** (`167bb4a3`): badge "Pasajero verificado" al conductor (enrich lazy, cero PII). tsc; display E2E pendiente del fix del match-404.
> - **Pendiente §4**: reconciliar `specs/VEO_SPEC_PASAJERO.md` + `docs/STATUS.md` (este ADR manda mientras).
> **Revierte** la decisión-cliente previa "el pasajero debe estar KYC-VERIFIED antes de su primer viaje"
> (`docs/STATUS.md:214,220`, comentario `services/bff/public-bff/src/trips/trips.service.ts:75-78`,
> `specs/VEO_SPEC_PASAJERO.md` KycCamera §). El liveness del pasajero pasa de **muro pre-viaje** a
> **verificación OPCIONAL que otorga un badge de confianza** (modelo Uber/BlaBlaCar/inDrive).
> NO toca el KYC del CONDUCTOR (que sigue siendo gate duro con binding face↔DNI↔licencia — ADR aparte).

---

## 0. Contexto y problema

Un pasajero recién onboardeado (teléfono + OTP + nombre + consentimientos Ley 29733) **no puede pedir un
viaje**: la pantalla de cotización muestra "Estamos verificando tu identidad · En revisión" y bloquea el
botón. Auditado end-to-end (2 pases adversariales, evidencia nivel 1):

### 0.1 El gate actual es real, doble-enforced y fue intencional

| # | Punto | Archivo |
| - | ----- | ------- |
| 1 | Gate BFF: `assertKycVerified()` → 403 `KYC_REQUIRED` si `kycStatus !== VERIFIED` | `services/bff/public-bff/src/trips/trips.service.ts:161-174` (invocado `:121`) |
| 2 | Gate defensa-en-profundidad (system-of-record) | `services/trip-service/src/trips/trips.controller.ts:65-67` (flag firmado en `public-bff/.../trips.service.ts:129`) |
| 3 | Gate UI (pre-empt, refleja el server) | `apps/passenger/src/features/trip/presentation/components/QuotingBody.tsx:164,643-656` |
| 4 | Transición PENDING→VERIFIED (liveness self-service, síncrono, auto-verifica) | `services/identity-service/src/kyc/kyc.service.ts:66-125` |

El pasajero se auto-verifica con **un liveness liviano** (selfie con gesto, sin DNI, sin operador) — mucho
más liviano que el conductor. El verify es **síncrono**: liveness pasa → VERIFIED en una transacción, o
REJECTED. **No hay período de revisión asíncrona.**

### 0.2 El bug: conflación de estado (nace en el estado equivocado)

El backend crea al pasajero nuevo directamente en `kyc_status = PENDING`. Pero la app interpreta `PENDING`
= *"ya mandaste tu selfie, esperá el resultado"* → renderiza `KycGate` en su cara **sin CTA**
(`apps/passenger/.../KycGate.tsx:55-63`). Como el verify es síncrono, **`PENDING` como "en revisión" casi
nunca es real** — es solo el estado inicial mal nombrado. Resultado: **el pasajero que NUNCA hizo nada
queda etiquetado "en revisión" y sin salida en la pantalla de pedir.** El estado inicial correcto de "no
arrancó" es `unverified`, no `pending` (que la app SÍ renderiza accionable: botón "Verificar ahora").

### 0.3 La industria no pone muro al pasajero para el primer viaje

| App | Pasajero para pedir | Verificación de identidad |
| --- | ------------------- | ------------------------- |
| inDrive | teléfono + nombre | selfie/DNI solo en ciertas regiones; señal de confianza |
| BlaBlaCar | puede reservar sin ID | **OPCIONAL** → badge "Perfil verificado"; obligatorio solo casos borde (transfronterizo) |
| Uber/Lyft | teléfono + método de pago | ID opcional/regional |

Patrón universal: **el piso es verificación de TELÉFONO** (que VEO ya hace). La identidad es un **badge de
confianza PROGRESIVO**, no un muro. El KYC pesado es del CONDUCTOR.

### 0.4 Compliance: no hay requisito legal de identificar al pasajero

- El ride-hailing en Perú **no está plenamente regulado**; la supervisión (ATU) apunta al **conductor**.
  No se halló requisito legal de verificación de identidad del **pasajero**.
- **Ley 29733 es protección de DATOS** (cómo se trata la PII), **no** un mandato de identificar al pasajero.
  Sigue aplicando a CÓMO se trata la biometría de quien SÍ verifica (ya cubierto: ONNX self-hosted, cifrado).

→ **Relajar el muro no rompe ninguna ley.** El KYC pre-viaje del pasajero era una decisión de producto de
VEO, no legal.

---

## 1. Decisión

**El liveness del pasajero deja de ser un muro pre-viaje y pasa a ser verificación OPCIONAL que otorga un
badge de confianza "Verificado".** El pasajero viaja con el piso teléfono + nombre.

1. **Sin gate de KYC en la creación del viaje.** Se retira `assertKycVerified()` del `POST /trips`
   (public-bff) y el re-check de `trip-service`. Un pasajero `unverified` PUEDE pedir.
2. **La verificación se ofrece desde Cuenta/Perfil** (ya existe el entry `ProfileScreen.tsx:480-530`), no
   desde la pantalla de pedir. Al pasar el liveness → `VERIFIED` → **badge de confianza**.
3. **El badge es visible al conductor** (estilo BlaBlaCar): el conductor ve si el pasajero está verificado
   al recibir la oferta — señal de confianza, sin exponer PII.
4. **Máquina de estados corregida:** el pasajero nace `UNVERIFIED`, no `PENDING`.

### 1.1 Máquina de estados (tipada — sin strings mágicos, ARQ §4-ter)

```
UNVERIFIED  ──(inicia y pasa liveness)──▶  VERIFIED
     │                                         │
     │ (opcional, nunca obliga a pedir)        │ (expira / se revoca)
     ▼                                         ▼
  [puede pedir viaje]                       EXPIRED ──(re-verifica)──▶ VERIFIED
     ▲                                         │
     └─────────────────────────────────────────┘  [seguir pudiendo pedir siempre]

REJECTED  ──(reintenta)──▶ VERIFIED     (un intento fallido NO bloquea pedir)
```

- **Estado inicial = `UNVERIFIED`** (no arrancó). Reemplaza el actual arranque en `PENDING`.
- `PENDING` queda SOLO para un futuro verify asíncrono (hoy inexistente: el verify es síncrono). Se
  mantiene en el enum por compatibilidad, pero **ningún pasajero nace ahí**.
- **Ninguna transición ni estado gatea la creación del viaje.** El único efecto de `VERIFIED` es el badge.
- Enum de dominio tipado (`identity-service/src/domain/kyc-status.ts` ya existe; se agrega/expone
  `UNVERIFIED` como estado inicial válido y transición `UNVERIFIED → [VERIFIED, REJECTED]`).

### 1.2 Lo que NO cambia

- El KYC del **conductor** (gate duro, binding face↔DNI↔licencia, aprobación de operador) — intacto.
- El motor de liveness (biometric-service ONNX self-hosted) y su tratamiento de PII (Ley 29733) — intacto.
- La pantalla `KycCamera` y su UX (anillo que respira, indicador de captura) — se reusa tal cual; solo
  cambia QUIÉN la invoca (opcional desde Perfil, no forzada por el gate de pedir).

---

## 2. Consecuencias

**A favor:**
- Fricción mínima para pedir (piso teléfono, como la industria) → más conversión, menos abandono.
- Cierra el dead-end de la conflación de estado (bug real).
- Desbloquea el flujo de match on-demand end-to-end para pruebas y para producción.
- El badge incentiva verificar (confianza mutua) sin obligar.

**En contra / a gestionar:**
- Por default el pasajero **no está identity-verified** → la trazabilidad de seguridad se apoya en (a) la
  **verificación del teléfono** (SMS soberano), (b) el **conductor verificado** + cámara + pánico, (c) el
  badge que empuja a verificar. **VEO sigue siendo seguridad-first** por el eje conductor, que es el que
  maneja el riesgo físico.
- Se puede endurecer selectivamente MÁS ADELANTE **sin volver al muro**: exigir badge solo en contextos de
  riesgo (p. ej. viajes nocturnos, efectivo, o tras N cancelaciones) — queda como palanca futura, no en este ADR.

---

## 3. Plan de construcción (lotes verificables)

| Lote | Alcance | Verificación |
| ---- | ------- | ------------ |
| **1** | Backend: estado inicial `UNVERIFIED` + retirar `assertKycVerified` de `POST /trips` (public-bff + trip-service). El viaje se crea sin gate de KYC. | `tsc` + tests identity/public-bff/trip-service + `auditar-core` (scope: trips.service/trip-service) + boot-real: pasajero `unverified` pide y crea trip |
| **2** | Migración: los `PENDING`-nunca-verificados → `UNVERIFIED` (los realmente VERIFIED no se tocan). | migración idempotente + verificación de conteos |
| **3** | App pasajero: quitar el `KycGate` de `QuotingBody` (pedir sin gate); mapear backend `UNVERIFIED`→app `unverified`; el entry de verificar queda SOLO en Perfil (badge). | `tsc` + boot-real: pedir viaje sin muro; verificar desde Perfil → badge |
| **4** | Badge de confianza visible al conductor (oferta/puja): "Pasajero verificado". Sin PII. | `tsc` + boot-real driver ve el badge |

Cada lote se entrega verificado antes del siguiente (regla del método). Lote 1 ya destraba el match test.

---

## 4. Reconciliación del plano (qué se actualiza al cerrar)

- `specs/VEO_SPEC_PASAJERO.md` — sección `KycCamera` + `Profile` StatusPill: la verificación es OPCIONAL
  (badge), no bloquea pedir. La copia "En revisión" deja de ser un estado de arranque.
- `docs/STATUS.md:214,220` — reemplazar "KYC pasajero E2E (decisión cliente: muro pre-viaje)" por el
  modelo progresivo de este ADR.
- Comentario `services/bff/public-bff/src/trips/trips.service.ts:75-78` — actualizar al retirar el gate.
