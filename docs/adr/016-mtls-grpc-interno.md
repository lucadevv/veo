# ADR 016 — mTLS para el gRPC interno: confidencialidad de transporte env-gated

> Estado: **ACEPTADO** (Seguridad/infra · ADR con código — el helper TLS-capable ya vive; la PKI es paso de
> deploy diferido). Cierra el **gap de código**: hoy los 11 servidores gRPC vivos y la factoría de clientes
> hardcodean `createInsecure()` → el canal interno va en **texto plano**. El HMAC (`verifyGrpcIdentity`) da
> **autenticación + integridad** de aplicación, pero **NO confidencialidad**: quien pueda esnifar la red
> interna lee el payload (PII de driver/trip/payment). Esta decisión hace el código **TLS-capable por
> entorno** (mTLS en prod, insecure en dev) SIN construir la PKI todavía — porque el deploy VPS aún no vive.

---

## 0. Contexto y problema

El gRPC interno (BFF→servicio para lecturas `Get*`, y servicio→servicio) ya tiene una capa de identidad
firmada: cada request lleva un HMAC que el receptor valida (`verifyGrpcIdentity`). Eso resuelve **autenticación**
(quién llama) e **integridad** (no fue alterado en vuelo). Lo que **falta** es **confidencialidad**: el canal
viaja **sin cifrar**.

Evidencia nivel-1 (working tree, verificado 2026-06-26):

- **Factoría de clientes (punto ÚNICO):** `packages/rpc/src/grpc-client.ts` construía el cliente con
  `credentials.createInsecure()`. La usan TODOS los clientes gRPC (los 3 BFFs + servicios consumidores como
  dispatch/booking/notification/rating).
- **11 servidores gRPC vivos:** cada `services/*/src/main.ts` hacía `connectMicroservice({ transport:
  Transport.GRPC, options: { … } })` **sin** pasar `credentials` → NestJS cae a su default
  `ServerCredentials.createInsecure()` (`node_modules/@nestjs/microservices/.../server-grpc.js`). Servicios:
  identity, trip, dispatch, payment, panic, media, audit, rating, share, fleet, places. (`booking-service`
  expone un server gRPC **diferido** a F2 — comentado en su `main.ts` —, no cuenta como vivo.)

### Threat model

El despliegue es **VPS único + Docker Compose**, red interna `veo-net` aislada; los puertos gRPC (50051+)
**NO se publican al host** y el único ingreso externo es Cloudflare Tunnel (ADR del modelo VPS, FOUNDATION
§0.7). Bajo ese modelo:

- **Atacante remoto sin acceso al host:** no alcanza los puertos gRPC (no publicados, firewall default-deny).
  La red aislada ya lo contiene. El cifrado aporta **poco** contra este actor.
- **Insider / proceso comprometido CON acceso al host (o a la red docker):** SÍ puede esnifar el bridge de
  Docker y leer el tráfico gRPC en claro → **PII de Ley 29733** (identidad de conductor, datos de trip,
  metadatos de pago) expuesta en tránsito. El HMAC **no lo impide** (firma ≠ cifra). **Este es el actor que
  el mTLS cierra.**
- **Movimiento lateral:** sin mTLS, cualquier proceso que entre a `veo-net` puede **hablar** con un servidor
  gRPC (el HMAC exige el secreto, pero el secreto vive en el mismo entorno). Con mTLS + `checkClientCertificate`,
  el servidor **exige y verifica el cert de cliente contra la CA interna**: un proceso sin cert provisionado
  **no completa el handshake**. Defensa en profundidad sobre el HMAC.

La regla maestra del cliente (FOUNDATION, CLAUDE.md regla #1) exige **TLS 1.3 + mTLS interno** para
compliance Ley 29733. El código en texto plano la incumplía. El bloqueo real para activar mTLS no es el
código sino la **PKI** (CA interna + cert por servicio), que es un paso de **provisión de deploy** — y el
deploy VPS todavía **no está vivo**.

---

## 1. Decisión

**Código TLS-capable, gated por entorno, AHORA. PKI provisionada en el deploy, DIFERIDA.**

### 1.1 Un helper compartido (DRY) en `@veo/rpc`

`packages/rpc/src/grpc-tls.ts` — UN solo módulo, consumido por la factoría de clientes y por los 11 mains de
servidor (cero duplicación):

- `buildGrpcServerCredentials(paths?, logger?): ServerCredentials` — con las 3 rutas →
  `ServerCredentials.createSsl(ca, [{ private_key, cert_chain }], /* checkClientCertificate */ true)`
  (mTLS: exige y verifica el cert del cliente); sin rutas → `ServerCredentials.createInsecure()`.
- `buildGrpcClientCredentials(paths?, logger?): ChannelCredentials` — con las 3 rutas →
  `credentials.createSsl(ca, key, cert)` (presenta el cert del cliente + verifica el server contra la CA);
  sin rutas → `credentials.createInsecure()`.
- `grpcTlsPathsFromEnv(source = process.env): GrpcTlsPaths` — único punto que lee los nombres `GRPC_TLS_*`
  (mismo patrón que `GRPC_URL`: el valor efectivo se lee de `process.env`, igual que los mains).

### 1.2 Degradación HONESTA (nunca finge mTLS)

| Estado de los certs                          | `GRPC_TLS_REQUIRED` | Comportamiento                                                        |
| -------------------------------------------- | :-----------------: | --------------------------------------------------------------------- |
| Las **3** rutas presentes                    | cualquiera          | **mTLS** real (cifra + verifica el peer contra la CA interna).        |
| **Ninguna** ruta presente                    | `false` (default)   | **insecure** (texto plano). Caso dev/test — no rompe el arranque local. |
| Ninguna ruta + entorno **endurecido** (prod) | `false` (default)   | insecure **+ WARN de boot claro** ("gRPC mTLS NO configurado… TEXTO PLANO"). NUNCA finge mTLS. |
| **Ninguna** ruta presente                    | **`true`**          | **fail-fast** tipado (`ValidationError`). El servicio **NO arranca en texto plano** (enforcement). |
| Ruta presente pero **archivo roto/ausente**  | cualquiera          | **fail-fast** tipado (`ValidationError`, `@veo/utils`). No degrada en silencio. |
| Config **parcial** (1-2 de 3)                | cualquiera          | **fail-fast** tipado. Un deploy a medio provisionar **falla ruidoso**, no se esconde en insecure. |

El `WARN` usa `isHardenedEnv()` (`@veo/utils`, único lector de `NODE_ENV==='production'`) y se emite **una
vez por proceso** (latch módulo-level): un BFF con ~12 clientes no spamea 12 WARNs. El fail-fast (required /
cert roto / parcial) **nunca** se dedupea — lanza siempre. Leer los certs va envuelto en error tipado: con la
ruta provista pero el archivo ilegible, el servicio **no arranca**.

**Lever de enforcement `GRPC_TLS_REQUIRED`** (default `false`, soft): mientras la PKI no exista, prod puede
deployar en texto plano (con el WARN visible). Una vez provisionados los certs, el operador pone
`GRPC_TLS_REQUIRED=true` y el servicio **rechaza arrancar sin mTLS** — convierte el "WARN suave" en un boot
**duro**. Default soft a propósito: NO rompe dev/preview ni el deploy pre-cert. Cumple la regla maestra del
cliente (mTLS interno en prod, Ley 29733) sin acoplar el rollout del código al rollout de la PKI.

### 1.3 Cableado

- **Factoría de clientes** (`grpc-client.ts`): `credentials.createInsecure()` →
  `buildGrpcClientCredentials(opts.tls)`. Cubre los ~15 clientes de un saque (todos pasan por la factoría).
  `GrpcClientOptions.tls?` permite inyección para tests; default = entorno.
- **11 servidores** (`services/*/src/main.ts`): `connectMicroservice` ahora pasa
  `credentials: buildGrpcServerCredentials()` — el **MISMO** helper en los 11 (DRY). `booking-service` deja
  documentado en su comentario diferido que usará el mismo helper al wirear su server en F2.

### 1.4 Contrato de env (FUENTE ÚNICA, DRY)

Fragmento zod compartido `grpcTlsEnvSchema` en `@veo/utils` (`packages/utils/src/env.ts`), spreadeado en el
`env.schema.ts` de cada servicio/BFF que hace gRPC (servidor y/o cliente) — mismo patrón que `outboxEnvSchema`:

```
GRPC_TLS_CA_PATH    # PEM de la CA interna (raíz de confianza mutua)        — opcional
GRPC_TLS_CERT_PATH  # PEM del cert de ESTE servicio/cliente                  — opcional
GRPC_TLS_KEY_PATH   # PEM de la clave privada de ESTE servicio/cliente       — opcional
GRPC_TLS_REQUIRED   # 'true' → enforcement (fail-fast sin certs)             — default 'false'
```

Las 3 rutas **opcionales**: **default ausente = insecure**. `GRPC_TLS_REQUIRED` es el lever de enforcement
(default `false`). Documentadas (comentadas, sin valores activos) en el `env/example.env` de cada uno.

### 1.5 Activación en prod (paso de DEPLOY — DIFERIDO)

mTLS se **activa** provisionando `GRPC_TLS_*` en el deploy: **CA interna** propia + **un cert por servicio**,
entregados vía **SOPS+age / docker-secrets** en `bootstrap-vps` (montados en `/run/secrets/…`). No requiere
cambio de código — solo presencia de los 3 archivos. Paso **final** del rollout: prender
`GRPC_TLS_REQUIRED=true` para que prod **rechace** correr sin mTLS (enforcement duro). La emisión/rotación de
los certs y el runbook de la PKI se documentan cuando el deploy VPS entre en línea.

---

## 2. Consecuencias

**Positivas**

- El canal gRPC interno pasa de **texto-plano-siempre** a **mTLS-en-prod** con un flip de provisión, sin tocar
  código. Cierra el hueco de **confidencialidad** Ley 29733 y suma **mutual auth de transporte** sobre el HMAC.
- DRY real: un helper, un fragmento de env. Agregar un servicio gRPC nuevo hereda el comportamiento gratis.
- **Honestidad operativa**: prod sin certs **lo grita** (WARN una vez por proceso), no simula seguridad.
  Config rota **falla al boot**, no en silencio.
- **Lever de enforcement** (`GRPC_TLS_REQUIRED=true`): el operador convierte el WARN suave en un boot **duro**
  una vez que la PKI está lista — prod **no puede** correr en texto plano por descuido. Desacopla el rollout
  del código (ya hecho) del de la PKI (deploy), sin dejar el enforcement librado al olvido.
- **Dev intacto**: sin `GRPC_TLS_*` y con `GRPC_TLS_REQUIRED` ausente/`false`, todo sigue insecure → los
  servicios bootean y los tests existentes pasan.

**Negativas / costos**

- mTLS **no está activo hasta** que exista la PKI: hasta el deploy VPS, el tráfico sigue en claro (mitigado por
  la red aislada + puertos no publicados — ver threat model). El WARN lo hace visible.
- Suma una dependencia operativa: **emisión y rotación** de certs por servicio (deuda de runbook, asumida).
- `@veo/rpc` se vuelve dependencia de 7 servidores que antes no la tenían (solo eran servers, no clients).

---

## 3. Alternativas consideradas

- **mTLS completo AHORA (PKI + certs ya):** RECHAZADO. El deploy VPS no vive; montar una CA + emisión + rotación
  sin un entorno donde correrla es trabajo especulativo que envejece. El **código** TLS-capable es lo que NO
  podemos diferir (toca 11 mains + la factoría); la **PKI** sí, porque es provisión de deploy.
- **Red aislada pura, sin cifrado (status quo):** RECHAZADO como estado final. La aislación contiene al actor
  remoto, pero **no al insider con acceso al host**, que es justo el modelo de amenaza de una plataforma de
  PII sensible (Ley 29733). El cifrado de transporte es defensa en profundidad no negociable por compliance.
- **TLS server-only (sin verificar el cert de cliente):** RECHAZADO. Daría confidencialidad pero no **mutual
  auth**; cualquier proceso en `veo-net` seguiría pudiendo hablar con los servers. `checkClientCertificate=true`
  cierra el movimiento lateral.
- **Service mesh (Linkerd/Istio sidecars) para mTLS automático:** RECHAZADO para el deploy VPS+Compose. Un mesh
  es peso de plataforma (control plane, sidecars) injustificado en un VPS único; el mTLS nativo de gRPC con
  certs montados es proporcional.

---

## 4. Diferido (no en este ADR)

- La **PKI**: CA interna, emisión de cert por servicio, política de rotación/expiración, runbook — paso de
  `bootstrap-vps` cuando el deploy entre en línea. El runbook debe incluir el **flip de `GRPC_TLS_REQUIRED=true`**
  como paso final (post-provisión de certs): es lo que convierte el WARN suave en enforcement duro. Mientras
  tanto queda en `false` (soft) para no bloquear el deploy pre-PKI.
- **CIDR exacto** de `veo-net` y endurecimiento de `TRUSTED_PROXY` para Cloudflare Tunnel (ver TODO(vps) en
  `parseTrustedProxy`).
- Cifrado del **otro** rail interno (REST firmado HMAC, `internal-rest.ts`): mismo razonamiento, fuera de scope.
