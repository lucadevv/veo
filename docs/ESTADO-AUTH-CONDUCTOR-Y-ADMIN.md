# Estado del AUTH — Conductor & Admin-web (registro de lo HECHO)

> **Propósito (convención 2026-06-27):** este doc registra el **estado REAL implementado** del auth de dos
> superficies, verificado contra código. Es el mapa de "dónde estamos" para no re-confundirse. Complementa
> `specs/VEO_SPEC_CONDUCTOR.md` (producto conductor) y `specs/VEO_SPEC_ADMIN.md` (producto admin) — esos dicen
> qué DEBE ser; este dice qué ESTÁ. Verificado: 2026-06-27 (commits hasta `378a7a6`).

---

## Transversal — Tokens, sesión y propagación de identidad

- **JWT ES256** (ECDSA P-256) vía `jose` (NO `jsonwebtoken`). identity-service FIRMA (privada), el BFF VALIDA
  (pública). Algoritmo tipado (`JWT_ALG`).
- **Access 15 min · Refresh 30 días.** Claims access: `sub`, `typ` (passenger|driver|admin), `roles[]` (vacío
  salvo admin), `sid`, `mfaAt?` (epoch de la última MFA fresca), `email?` (SOLO admin — privacidad de
  pasajero/conductor).
- **Refresh rotation + reuse-detection** en Redis (`RedisRefreshTokenStore.rotate(sid, jti)`): reusar un
  refresh viejo mata la familia de sesión. El refresh repuebla roles/email desde DB.
- **Validación SOLO en el BFF**; a los servicios internos viaja **identidad firmada HMAC** (`InternalIdentityGuard`,
  anti-IDOR entre servicios).
- **Rate-limiting** granular en todos los endpoints de auth (anti-IP-spoof hardened, commit `011f59c`).
- **Auditoría al WORM** (Ley 29733): `auth.login`, `auth.logout`, `auth.totp-enrolled`, `auth.step-up`,
  `admin.role_changed`. Fail-open honesto (si audit cae, logea ERROR, no bloquea).

---

## SUPERFICIE 1 — AUTH CONDUCTOR (driver-app + driver-bff + identity-service)

### Métodos de login
| Método | Estado | Detalle |
|---|---|---|
| **OTP SMS** (teléfono PE +51) | ✅ | 6 dígitos, solicitado válido 10 min, timeout 5 min. SMS soberano (SMPP). Rate-limited (5/10min IP+tel · 20/10min IP). |
| **Google OAuth** | ✅ | id_token verificado server-side contra Google JWKS (ADR-012). |
| **Apple OAuth** | ✅ | identityToken verificado contra Apple JWKS (Guideline 4.8). |
| **Email + password** | ✅ | Argon2id + verificación por código (anti-enumeración) + reset con revocación de sesiones. |
| **WhatsApp OTP** | ⏳ planeado | El spec lo pide como PRINCIPAL; hoy SMS soberano (espera `WhatsAppSender`, ADR-012 Lote 3). **Gap intencional.** |
| **Re-login biométrico de dispositivo** (Face ID/Android) | ✅ | Distinto del gate de turno. Keychain/Keystore con `BIOMETRY_CURRENT_SET` + `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`; `KeychainLocalAuthService` cableado (`useBiometricRelogin` + DI), distingue cancelación de fallo real (banner), y sincroniza/limpia el token en rotación/revocación. |

### Onboarding / registro — máquina de estados ✅
`NOT_STARTED → IN_PROGRESS → IN_REVIEW → APPROVED | REJECTED` (wizard reanudable por `currentStep`):
1. **Datos personales** — nombre, DNI (8 díg, **cifrado AES-256-GCM en reposo**, enmascarado al conductor; compliance lo descifra al revisar), fecha nac.
2. **Vehículo** — tipo (Auto/Moto derivado de categoría MTC), placa, año, **modelo de catálogo curado**.
3. **Documentos** — Licencia A1, SOAT, tarjeta de propiedad, **foto del vehículo (REQUERIDA para aprobar)**, DNI (2 caras). No avanza sin los críticos.
4. **KYC facial** — 1 selfie con **liveness PASIVO (PAD single-frame, sin lag)** + match ArcFace selfie↔DNI+licencia (ejecutado al aprobar). Anti-spoof: 422 → no persiste conductor spoof. `approve()` exige `dniFaceMatchedAt != null` (match ejecutado; el veredicto lo decide el operador). **DEUDA: calibrar índice/umbral PAD con set real/spoof antes de prod.**

### Gate biométrico de TURNO ✅
Liveness **ACTIVO** (challenge: `TURN_LEFT|TURN_RIGHT|NOD|SMILE`, one-shot, `expiresAt`) obligatorio cada turno, **sin bypass ni override de UI**. 3 fallos = bloqueo 1h (solo central destraba). *(Distinto del KYC: turno=ACTIVO, KYC=PASIVO.)*

### Estado conductor: **~97% operativo.** Falta: WhatsApp OTP (planeado — hoy SMS soberano). Deudas menores: calibración PAD, share-service SMS adapter prod.

---

## SUPERFICIE 2 — AUTH ADMIN-WEB (admin-web + admin-bff + identity-service)

### Login del operador ✅
**Email corporativo + password (Argon2id) + TOTP (MFA obligatorio).** Primer login: challenge QR/otpauth → enrola en Authenticator → confirma 6 díg. Logins posteriores: email+pass+TOTP. Rate-limited (login 10/10min, totp 10/10min, invite 10/10min; logout `@SkipRateLimit`).

### RBAC — 7 roles + matriz ✅
Roles por rango: `SUPPORT_L1`(10) · `SUPPORT_L2`(20) · `DISPATCHER`(30) · `FINANCE`(30) · `COMPLIANCE_SUPERVISOR`(40) · `ADMIN`(90) · `SUPERADMIN`(100).

| Permiso | quién |
|---|---|
| `ops:view` · `trips/drivers:view` | SUPPORT+ / la mayoría |
| `drivers:approve` · `fleet:view/review` · `panics:resolve` · `media:view/request/approve` | COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN |
| `finance:view/refund` | FINANCE, ADMIN, SUPERADMIN |
| **`finance:payout`** (EXCLUSIVO) | **solo FINANCE** (ni ADMIN ni SUPERADMIN) |
| **`audit:view/verify`** (EXCLUSIVO) | **solo COMPLIANCE_SUPERVISOR + SUPERADMIN** (separación de funciones, Ley 29733: quien opera NO audita) |

- **Doble gate:** server-side `@Roles(...)` + `RolesGuard` (autoritativo) · UI `can(user, permission)` (oculta, defensa en profundidad — la UI NO autoriza).
- **Anti-escalada:** un actor solo otorga roles de rango ESTRICTAMENTE menor al suyo (excepción SUPERADMIN→SUPERADMIN). `canGrantRoles`.

### Step-up MFA ✅
TOTP fresco (**< 5 min**, `mfaAt` en el token) exigido para acciones sensibles vía `@RequireStepUpMfa()` + `StepUpMfaGuard`. Lo exigen: **media** (approve/stream video, live token), **pánico** (resolve), **pricing** (modo puja/fijo, recargo combustible), **dispatch-config**, **catalog**. DEV bypassa (`!isHardenedEnv()`); PROD/PREVIEW exige. Endpoint `POST /admin/step-up`. Badge "MFA fresco/inactivo" en el topbar.

### Gestión de operadores ✅
`createOperator(email, roles)` (SUPERADMIN/ADMIN) → INVITED + `inviteToken` one-shot TTL 24h + evento `admin.role_changed` al WORM (atómico). `acceptInvite(token, password)` → ACTIVE (Argon2id). Listado `GET /admin/operators`.

### Estado admin: **100% operativo, alineado con `VEO_SPEC_ADMIN.md`.**

---

## Specs vs realidad (lo que hay que saber)
- **`VEO_SPEC_CONDUCTOR.md`**: pide **WhatsApp PRINCIPAL** para el OTP; el código usa **SMS soberano** (WhatsApp planeado). Gap intencional pendiente del adapter.
- **`VEO_SPEC_ADMIN.md`**: **100% alineado** con el código (login email+TOTP, step-up, 7 roles, separación de funciones, `finance:payout` exclusivo).
- Vectores de seguridad ya cerrados (auditorías 2026-06): OAuth sandbox bypass, X-Forwarded-For, rate-limit granular, DNI cifrado, TOTP_ENC_KEY secreto, reuse-detection, segregación FINANCE/payout.
- Deudas menores abiertas: calibración umbral PAD, WhatsApp onboarding, share-service SMS prod, identity-gRPC sin actor-binding (ver memoria del proyecto + follow-ups de auth).
