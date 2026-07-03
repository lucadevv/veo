# ADR 012 — Métodos de autenticación multi-método SOBERANOS (pasajero/conductor)

> Estado: **RATIFICADO** (§8 cerradas 2026-06-05). Reemplaza la línea implícita de `FOUNDATION §14`
> ("pasajero = phone+OTP SMS") por **auth multi-método**: **Google + correo+contraseña + teléfono+OTP**,
> construido vía el patrón `puerto + sandbox + adapter` (`§0.7`). El **OTP se entrega por WhatsApp
> (PRINCIPAL)** con **SMS como FALLBACK soberano** (si WhatsApp falla, cae a SMS automático). WhatsApp es
> excepción `§0.7` documentada (Meta Cloud API tras puerto, mismo trato que FCM/APNs); el SMS por SMPP
> mantiene la red soberana. **Facebook** y **OTP-por-llamada** quedan **fuera de scope** (a futuro).

---

## 0. Contexto y problema

Tres fuentes en conflicto sobre los métodos de login del pasajero:

1. **Design-handoff** (`docs/design-handoff/project/pasajero/screens-pass.jsx:107-152`, `chats/chat1.md:201,802,854`) — la
   fuente de verdad de UI/flujo (regla del dueño): **Google · Facebook · correo+contraseña · teléfono+OTP**, con
   fallbacks de OTP por **llamada · WhatsApp**.
2. **`FOUNDATION.md:355` (§14, decisión registrada)** — "Login: pasajero = phone+OTP **SMS**". CERO mención de
   OAuth/Google/Facebook/correo-para-pasajero/WhatsApp.
3. **`FOUNDATION.md:26-33` (§0.7, regla maestra)** — soberanía: "no depende de SaaS de terceros … todo propio /
   self-hosted". Google/Facebook (IdP), WhatsApp (Meta), llamada (VoIP) **son rieles de terceros**.

La app ya migró la UI a los 4 métodos (Lote A), pero solo **teléfono+OTP** tiene backend; el resto es
"Próximamente" (degradación honesta). El conflicto bloquea avanzar: "seguir el diseño" choca con "seguir la
arquitectura".

**El insight que lo resuelve:** `§0.7` NO prohíbe los rieles externos inevitables — los admite "detrás de un
**conector mínimo SIEMPRE detrás de un puerto propio intercambiable** (`interface` + adapter + sandbox)", y aclara
que "**librerías open-source self-hosted NO cuenta como dependencia**". El repo ya aplica esto: `SmsSender` (SMPP
directo, no Twilio), `EmailSender` (SMTP propio), `PushSender` (FCM/APNs tras puerto), `BiometricProvider` (servicio
ONNX propio). **OAuth y voz caen en la misma categoría.** Solo WhatsApp no tiene salida soberana.

---

## 1. Decisión arquitectónica

**Construir TODOS los métodos del diseño manteniendo soberanía, EXCEPTO WhatsApp**, replicando el patrón de puertos
ya establecido. La UI no cambia (ya está fiel al diseño); se construye el backend método por método.

### 1.1 Patrón: `puerto + sandbox + adapter` por método (precedente: `PushSender`)

Cada método nuevo sigue la estructura ya usada en `notification-service/src/ports/*` e `identity-service/src/ports/*`:

```
src/ports/<metodo>/<metodo>.port.ts        # interface + Symbol (el dominio depende de ESTO, no del adapter)
src/ports/<metodo>/<metodo>.module.ts      # factory por env VEO_<METODO>_MODE → { sandbox | live }
                                           #   sandbox = determinista, sin red (dev/CI)
                                           #   live    = conector mínimo al riel (implementado por NOSOTROS)
```

El dominio (`auth.service`) inyecta el puerto por `Symbol` y **no sabe** si es sandbox o live (igual que hoy con
`@Inject(SMS_SENDER)`). El `PushSender` es el precedente exacto: enruta **dos rieles inevitables** (FCM de Google +
APNs de Apple) desde un puerto, con cliente propio (`fcm-client.ts`, `apns-client.ts`) — sin Firebase SDK.

### 1.2 Matriz método × soberanía (la decisión, de más a menos soberano)

| Método                                | Soberanía                           | Cómo se soberaniza (riel inevitable + self-hosted)                                                                                                                                                                                                                          | Secretos/Infra                          | Estado                                         |
| ------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| **Teléfono + OTP**                    | ✅ Soberano                         | SMPP 3.4 directo al operador (`SmsSmppSender`). Riel: operador SMS.                                                                                                                                                                                                         | `SMPP_*`                                | **construido** (falta cablear live)            |
| **Correo + contraseña**               | ✅ 100% soberano                    | SMTP propio (`EmailSmtpSender`, nodemailer) + hash **argon2id** (patrón `AdminUser`). Sin terceros.                                                                                                                                                                         | `SMTP_*`                                | a construir                                    |
| **Google (OAuth2/OIDC)**              | ✅ Soberano (tras puerto)           | Implementamos el cliente OAuth y **verificamos el `id_token` contra el JWKS público de Google** (`jose`). Sin Auth0/Firebase. Riel: IdP de Google (= FCM).                                                                                                                  | `GOOGLE_CLIENT_ID/SECRET`               | a construir                                    |
| **Sign in with Apple (pasajero iOS)** | ✅ Soberano (tras puerto)           | OIDC: verificamos el `id_token` contra el **JWKS público de Apple** (`jose`), mismo patrón que Google. **Solo pasajero en iOS** (App Store Review Guideline 4.8 — ver Enmienda 2026-06-21). El driver-bff NO lo expone. Riel: IdP de Apple (= APNs).                          | `APPLE_CLIENT_ID` + key Sign-in         | a construir (enmienda 2026-06-21)              |
| **WhatsApp (entrega OTP, PRINCIPAL)** | ⚠️ **Excepción §0.7** (no soberano) | Canal **principal** de entrega del OTP (no es método de login): Meta Cloud API tras un puerto `WhatsAppSender`, **mismo trato que FCM/APNs**. Se manda por WhatsApp primero; **si falla → cae a SMS automático**. NO usar emuladores Evolution/OpenWA (violan ToS, banean). | `WHATSAPP_*` (Meta) + template aprobado | a construir (puerto; live necesita creds Meta) |
| **SMS (entrega OTP, FALLBACK)**       | ✅ Soberano                         | Red de respaldo del OTP: SMPP 3.4 directo al operador (`SmsSmppSender`). Solo entra si WhatsApp no entrega.                                                                                                                                                                 | `SMPP_*` del operador                   | **construido** (falta cablear live)            |
| ~~Facebook (OAuth2)~~                 | —                                   | **Fuera de scope** (a futuro). Su uso viene cayendo; se prioriza Google.                                                                                                                                                                                                    | —                                       | diferido                                       |
| ~~OTP por llamada (voz)~~             | —                                   | **Fuera de scope** (a futuro). Soberanizable (Asterisk+SIP+TTS Piper) pero infra pesada; ya hay fallback (WhatsApp/correo).                                                                                                                                                 | —                                       | diferido                                       |
| **Re-login biométrico**               | ✅ Soberano                         | Face ID/huella local (Secure Enclave/Keystore), refresh local. + gate de turno con `biometric-service` propio (ONNX).                                                                                                                                                       | —                                       | **construido**                                 |

> **Regla de oro:** ningún método introduce un SaaS de auth (Auth0/Firebase/Clerk/Cognito). Donde hay un riel
> inevitable (Google/Meta IdP, operador SMS/voz), el conector lo escribimos nosotros tras un puerto + sandbox.

---

## 2. Dominio y datos (PLAYBOOK §2)

Hoy el `User` está **clavado al teléfono** (`schema.prisma:80` `phone @unique`; `email` nullable y sin uso de auth;
sin `passwordHash`/OAuth). Para multi-método + **account-linking** se introduce una tabla de credenciales por método:

```prisma
enum AuthMethodType { PHONE_OTP  EMAIL_PASSWORD  GOOGLE_OAUTH  FACEBOOK_OAUTH  CALL_OTP }

model AuthMethod {
  id            String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId        String          @map("user_id") @db.Uuid
  user          User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  type          AuthMethodType
  // EMAIL_PASSWORD
  email         String?         // verificado antes de operar (Ley 29733)
  passwordHash  String?         @map("password_hash")  // argon2id (copiar de AdminUser)
  emailVerified Boolean         @default(false) @map("email_verified")
  // OAUTH (Google/Facebook)
  oauthSubject  String?         @map("oauth_subject")  // `sub` del IdP, verificado server-side
  // estado
  verified      Boolean         @default(false)
  createdAt     DateTime        @default(now())
  @@unique([userId, type])
  @@unique([type, oauthSubject])  // un (provider, sub) → un solo User (anti-duplicado)
  @@unique([type, email])         // un correo → una credencial de correo
  @@map("auth_methods")
}
```

- **User sigue teniendo `phone @unique`** (no se rompe lo existente); el primer login por teléfono crea el `User` y
  su `AuthMethod{PHONE_OTP}`. Los demás métodos cuelgan del mismo `User`.
- **Account-linking** (PLAYBOOK §6 dominó): si llega un login (Google) cuyo `email` ya existe en un `AuthMethod`
  verificado, se **vincula** al `User` existente (no se duplica). Decisión de colisión en §5.
- **Tokens efímeros** (verificación de correo, reset de contraseña) → Redis con TTL (NO tabla), igual que el OTP.
- `revokeAllForUser` (ya existe en `refresh-store.ts:70`) se expone para "cerrar sesión en todos los dispositivos"
  y se invoca en cambio de contraseña / borrado de cuenta.

---

## 3. Acceso (MENTORIA · la UI no autoriza)

- **La verificación del método vive SERVER-SIDE, nunca en el cliente.** El OAuth NO se confía al cliente: el app
  obtiene el `code`/`id_token` del IdP y el **backend lo verifica** (firma JWKS de Google / debug_token de Meta)
  antes de emitir JWT VEO. El cliente jamás "se autodeclara" Google-autenticado.
- Endpoints de auth: `@Public` (pre-sesión) pero con **rate-limit por método** (request-otp, login-password,
  oauth-exchange) — además del cap por-OTP que ya existe.
- Tras cualquier método, el resultado es **el mismo JWT ES256 + refresh rotado** de hoy: el resto del sistema
  (PLAN∩ROL∩TENANT, guards, BFF→HMAC) no cambia. El método de login es ortogonal a la autorización.
- **Consent Ley 29733 por método**: Google/Facebook entregan datos (email/nombre) → consentimiento explícito antes
  de crear el `User` (la tabla `Consent` append-only ya existe).

---

## 4. Flujo soberano por método (resumen — detalle en tasks)

- **Teléfono+OTP** (hecho): `request → SMPP → verify → JWT`. Falta `VEO_SMS_MODE=live` + creds del operador.
- **Correo+contraseña**: `register(email,password)` → argon2id + email de verificación (**código OTP emailado,
  Redis TTL 10min** — coherente con §8.5 "código OTP, no magic-link"; el "24h" del borrador era de la era
  magic-link y se descartó: un código OTP de 6 dígitos válido 24h es brute-forceable) → `verify-email` →
  `login` (argon2.verify) → JWT. + `forgot-password`/`reset` (token Redis TTL 1h). SMTP propio.
- **Google**: app abre el IdP (Custom Tab/ASWebAuthenticationSession) → `code` por deep-link → backend
  `POST /auth/oauth/google/exchange` → verifica `id_token` (JWKS Google) → `AuthMethod{GOOGLE_OAUTH, sub, email}` →
  link-or-create → JWT.
- **Facebook**: idéntico a Google contra los endpoints de Meta.
- **OTP por llamada**: `request-call` → OTP → Asterisk marca el número → TTS self-hosted locuta el código → `verify`
  (mismo `OtpService`, branch de canal). Infra SIP/TTS self-hosted.

---

## 5. Caminos infelices (PLAYBOOK §5.3)

- **Colisión de cuentas**: login Google con email ya registrado por correo+contraseña → **vincular** al `User`
  existente (no duplicar), exigiendo que el email del IdP esté `email_verified=true` en el token. Si el correo del
  método existente NO estaba verificado → pedir verificación antes de vincular (anti-takeover).
- **OAuth cancelado / token inválido / expirado** → 401, la app vuelve al 'start' sin sesión.
- **Correo no verificado** → no permite `login`; reenvía verificación (con cooldown).
- **Reset de contraseña** → token de un solo uso, TTL 1h, invalida sesiones (`revokeAllForUser`).
- **Recuperación de cuenta** (perdí el teléfono, único método) → fallback a correo verificado si existe; si no,
  soporte. (Decisión en §8.)
- **Doble-tap / reenvío / offline** → ya cubierto por el patrón actual del OTP; replicar en correo/oauth.

---

## 6. WhatsApp — EXCEPCIÓN §0.7 explícita y acotada (decisión del dueño)

WhatsApp **NO es soberano** y se acepta como **excepción documentada** de `§0.7`, acotada a **un solo uso: la
entrega del OTP** (NO es método de login, NO recibe ni procesa más datos).

- **Realidad técnica (verificada)**: desde **2025-10-23** Meta deprecó la API on-premise → **solo WhatsApp Cloud
  API, hosteada en servidores de Meta**, de pago, con templates aprobados. No hay self-hosting legítimo (Evolution
  API / OpenWA emulan WhatsApp-Web, **violan ToS y banean el número** — PROHIBIDOS para este flujo).
- **Por qué se acepta igual**: es la misma categoría que `§0.7` ya admite para **FCM/APNs** ("push nativo de
  Google/Apple") — un **riel de entrega externo tras un conector mínimo en un puerto propio**. El OTP lo generamos
  nosotros; Meta solo es el cartero de ese mensaje, intercambiable.
- **Contención de la excepción**:
  1. **Red soberana SIEMPRE detrás**: WhatsApp es el canal **principal**, pero el OTP **cae a SMS (SMPP soberano)
     automáticamente si WhatsApp no entrega** (timeout/fallo/usuario sin WhatsApp). Nunca queda sin red soberana →
     no es un single-point-of-failure de Meta.
  2. **Tras puerto** `WhatsAppSender` (interface + sandbox + adapter Cloud API) → reemplazable el día que exista una
     vía soberana, sin tocar el dominio.
  3. **Mínimo acoplamiento**: solo enviamos el template de OTP; no recibimos webhooks de conversación ni guardamos
     nada en Meta.

> Esta es la **única** excepción aceptada a `§0.7` en el auth. Cualquier ampliación del uso de WhatsApp
> (chat, notificaciones de viaje, etc.) requiere su propio ADR.

---

## 7. Puntos de integración / lotes (para tasks — NO es código aún)

Orden propuesto (de más soberano/fácil a más infra):

1. **Schema `AuthMethod` + migración + account-linking** (base para todo lo demás).
2. **Correo + contraseña** (100% soberano, infra SMTP lista, patrón `AdminUser`): register/verify/login/forgot/reset.
3. **Google OAuth** (puerto + verificación `id_token` JWKS) → **Facebook OAuth** (mismo patrón).
4. **Canales del OTP**: puerto **`WhatsAppSender`** (PRINCIPAL; sandbox en dev, live con creds Meta + template) +
   `SmsSmppSender` (FALLBACK soberano). El `OtpService` orquesta: intenta WhatsApp → si falla/timeout, cae a SMS.
5. **Transversal**: listar/revocar sesiones, **recuperación por-método**, consent por método.

Cada lote: puerto+sandbox primero (anda en dev sin secretos), luego adapter live tras env. Boot-real por lote.

---

## 8. Decisiones de producto — RATIFICADAS (2026-06-05)

1. **Métodos de login**: **Google + correo+contraseña + teléfono+OTP**. ✅
2. **Facebook**: **fuera de scope** (a futuro). Se prioriza Google.
3. **OTP por llamada**: **fuera de scope** (a futuro). Hay fallback con WhatsApp/correo.
4. **Entrega del OTP**: **WhatsApp (PRINCIPAL) → SMS (FALLBACK soberano, automático si WhatsApp falla)**.
   Invertido respecto al borrador inicial: WhatsApp al frente (mercado PE), SMS como red de respaldo soberana.
5. **Verificación**: número → OTP (SMS/WhatsApp); **correo → código OTP emailado** por SMTP propio (no magic-link).
6. **Recuperación: POR MÉTODO** (correo→correo, número→OTP al número, Google→re-login Google). Si el `User` tiene
   varios métodos vinculados, puede recuperar por cualquiera de los verificados.
7. **¿Correo obligatorio para todos?**: **NO** — solo si elegiste correo como método. El que entra por teléfono o
   Google no está obligado a tener correo (la recuperación es por su propio método). (Ley 29733: el consentimiento y
   los datos se rigen por el método usado.)

---

## Enmienda 2026-06-21 — Sign in with Apple (pasajero iOS)

> No reescribe la historia del ADR (§8 sigue ratificada como estaba el 2026-06-05). Esta enmienda **agrega** un
> método al alcance, por una restricción de plataforma descubierta después.

- **Qué se agrega:** **Sign in with Apple** como método de login del **pasajero en iOS**.
- **Por qué (no es opcional):** **App Store Review Guideline 4.8** — si la app ofrece login con un servicio social de
  terceros (en nuestro caso, **Google OAuth**), Apple **obliga** a ofrecer también Sign in with Apple como
  alternativa equivalente. Sin esto, Apple rechaza la app en review. No es una preferencia de producto: es un gate
  de publicación en la App Store.
- **Alcance acotado:** **solo pasajero, solo iOS**. El **driver-bff NO lo expone**; el **conductor sigue
  teléfono+OTP + Face ID** (su login no ofrece social de terceros, así que la 4.8 no aplica). En Android tampoco
  aplica (no hay tienda de Apple).
- **Soberanía:** Apple es un **IdP OIDC**, misma categoría §0.7 que Google (riel inevitable tras puerto). Verificamos
  el `id_token` contra el **JWKS público de Apple** con `jose`, server-side — sin SaaS de auth. Mismo trato que
  APNs en `PushSender`.
- **Datos / Ley 29733:** Apple puede entregar email (real o relay `@privaterelay.appleid.com`) y nombre **solo en el
  primer login** → persistir en ese momento; consentimiento explícito antes de crear el `User`, igual que Google.
- **Account-linking:** un login Apple cuyo email ya existe verificado en otro `AuthMethod` se **vincula** al `User`
  (no duplica), con las mismas reglas anti-takeover de §5. Nuevo valor de enum sugerido: `AuthMethodType.APPLE_OAUTH`.

---

_Decisión RATIFICADA: multi-método (Google + Apple [iOS, enmienda 2026-06-21] + correo + teléfono) vía `puerto+sandbox+adapter` (§0.7). OTP por SMS
(soberano) + WhatsApp (única excepción §0.7, acotada a entrega, tras puerto). Facebook y llamada diferidos. La UI ya
está (Lote A); falta el backend por método + la tabla `AuthMethod`. Próximo: tasks → apply, lote por lote, empezando
por `AuthMethod` + correo (100% soberano, infra SMTP lista)._
