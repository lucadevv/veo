/**
 * Contrato móvil VEO (apps RN passenger/driver) ↔ BFFs.
 * Zod = fuente de verdad; los tipos se infieren. Las formas reflejan EXACTAMENTE lo que devuelven
 * los controllers/DTOs reales de `public-bff` (pasajero) y `driver-bff` (conductor).
 * Montos siempre en céntimos PEN (enteros). Fechas ISO-8601 string. Sin mocks: estos shapes son los
 * que las apps deben enviar/parsear contra los BFFs reales.
 *
 * Transporte:
 *  - Pasajero  → public-bff REST `/api/v1/*` + Socket.IO namespace `/passenger` (Bearer JWT, type passenger).
 *  - Conductor → driver-bff  REST `/api/v1/*` + Socket.IO namespace `/driver`    (Bearer JWT, type driver).
 */
import { z } from 'zod';
import { documentSide, geoPoint, payoutStatus, tripStatus } from './types.js';
import type { TripStatus } from './types.js';
import type { DriverLocationMsg, TripUpdateMsg } from './socket.js';

/* ───────────────────────── Comunes ───────────────────────── */

/** Métodos de pago soportados (espeja `PaymentMethod` de @veo/shared-types). */
export const mobilePaymentMethod = z.enum(['YAPE', 'PLIN', 'CASH', 'CARD', 'PAGOEFECTIVO']);
export type MobilePaymentMethod = z.infer<typeof mobilePaymentMethod>;

/**
 * Estado de la afiliación Yape On-File del pasajero (Yape On File · ProntoPaga). FUENTE TIPADA del estado
 * de DOMINIO VEO — espeja el enum Prisma `AffiliationStatus` de payment-service. NO confundir con el estado
 * del PROVEEDOR que devuelve el gateway (`showYapeSubscription`, incluye 'ACCEPTED'): ese es contrato del
 * adaptador y vive del lado del servicio. Acá van solo los 4 estados que el BFF expone a la app:
 *   PROCESS = en trámite · ACTIVE = vinculada (cobro automático) · EXPIRED = venció · REVOKED = revocada.
 * La app compara contra `affiliationStatus.enum.*` (§4-ter: nunca literales sueltos).
 */
export const affiliationStatus = z.enum(['PROCESS', 'ACTIVE', 'EXPIRED', 'REVOKED']);
export type AffiliationStatus = z.infer<typeof affiliationStatus>;

/**
 * Tipo de vehículo (Ola 2B · tier moto-taxi). Espeja `VehicleType` de @veo/shared-types.
 * MOTO = mototaxi (más barato); CAR = auto. La app lo toma de `quoteOption.vehicleType` y lo
 * envía en `createTripRequest.vehicleType` para que dispatch filtre el matching por tipo.
 */
export const mobileVehicleType = z.enum(['CAR', 'MOTO']);
export type MobileVehicleType = z.infer<typeof mobileVehicleType>;

/**
 * Modo de pricing/despacho del viaje (ADR 011). Espeja `PricingMode` de @veo/shared-types.
 * PUJA = "proponé tu precio" (marketplace de ofertas, ADR 010): la app muestra la pantalla de bid con
 * piso/sugerido. FIXED = tarifa fija calculada estilo Uber: la app muestra el precio firme por categoría.
 * El SERVIDOR resuelve el modo (no el cliente); el quote lo expone para que la app pinte la pantalla
 * correcta. El modo autoritativo se RE-RESUELVE al crear el viaje (el quote es una pista).
 */
export const pricingMode = z.enum(['PUJA', 'FIXED']);
export type PricingMode = z.infer<typeof pricingMode>;

/**
 * Solicitud especial del pasajero al conductor (BE-2): PET = mascota · LUGGAGE = equipaje ·
 * CHILD_SEAT = silla de niño. El conductor las VE antes de aceptar. "Parada" no va acá (es un waypoint).
 */
export const specialRequest = z.enum(['PET', 'LUGGAGE', 'CHILD_SEAT']);
export type SpecialRequest = z.infer<typeof specialRequest>;

/** Tipo de cuenta que solicita/verifica el OTP. */
export const accountType = z.enum(['PASSENGER', 'DRIVER']);
export type AccountType = z.infer<typeof accountType>;

/* ═══════════════════════ PASAJERO (public-bff) ═══════════════════════ */

/* ── Auth por teléfono + OTP ── */

/** Teléfono peruano (BR-I06): 9XXXXXXXX, opcionalmente con prefijo de país 51/+51. */
const peruPhone = /^\+?(?:51)?9\d{8}$/;

/** POST /auth/otp/request → body. */
export const otpRequest = z.object({
  phone: z.string().regex(peruPhone, 'Teléfono peruano inválido'),
  type: accountType,
});
export type OtpRequest = z.infer<typeof otpRequest>;

/** POST /auth/otp/request → respuesta. */
export const otpRequestResult = z.object({ sent: z.literal(true) });
export type OtpRequestResult = z.infer<typeof otpRequestResult>;

/** POST /auth/otp/verify → body. */
export const otpVerify = z.object({
  phone: z.string().regex(peruPhone, 'Teléfono peruano inválido'),
  code: z.string().length(6),
  type: accountType,
});
export type OtpVerify = z.infer<typeof otpVerify>;

/**
 * Usuario mínimo que devuelve identity tras autenticar (sessionUser del pasajero).
 * `phone` es nullable: el alta por correo (ADR-012) crea la cuenta SIN teléfono, así que el
 * usuario puede no tenerlo aún. `email` es opcional y solo viene presente en el flujo correo.
 */
export const mobileSessionUser = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  type: z.string(),
  kycStatus: z.string(),
  email: z.string().nullable().optional(),
});
export type MobileSessionUser = z.infer<typeof mobileSessionUser>;

/** POST /auth/otp/verify → respuesta: tokens + sessionUser. */
export const mobileAuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: mobileSessionUser,
});
export type MobileAuthTokens = z.infer<typeof mobileAuthTokens>;

/** POST /auth/refresh → body / respuesta. */
export const mobileRefreshRequest = z.object({ refreshToken: z.string() });
export type MobileRefreshRequest = z.infer<typeof mobileRefreshRequest>;
export const mobileRefreshResult = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type MobileRefreshResult = z.infer<typeof mobileRefreshResult>;

/** POST /auth/logout → body / respuesta. */
export const mobileLogoutRequest = z.object({ refreshToken: z.string() });
export type MobileLogoutRequest = z.infer<typeof mobileLogoutRequest>;
export const mobileLogoutResult = z.object({ ok: z.literal(true) });
export type MobileLogoutResult = z.infer<typeof mobileLogoutResult>;

/* ── Auth por correo + contraseña (ADR-012) ── */

/**
 * Mínimo de contraseña (ADR-012 §4): 12 caracteres. El backend ADEMÁS rechaza contraseñas
 * triviales aunque cumplan la longitud; eso lo valida el servicio (400 VALIDATION), no el cliente.
 */
const EMAIL_PASSWORD_MIN = 12;

/** Correo del usuario (validación de borde; el backend re-normaliza a minúsculas). */
const emailAddress = z.string().email('Correo inválido');

/** POST /auth/email/register → body. Crea la cuenta y envía un código de 6 dígitos al correo. */
export const emailRegister = z.object({
  email: emailAddress,
  password: z.string().min(EMAIL_PASSWORD_MIN, 'La contraseña debe tener al menos 12 caracteres'),
  name: z.string().min(1).max(80).optional(),
  type: accountType,
});
export type EmailRegister = z.infer<typeof emailRegister>;

/** POST /auth/email/register → respuesta: solo confirma el envío del código (NO emite tokens). */
export const emailRegisterResult = z.object({ sent: z.literal(true) });
export type EmailRegisterResult = z.infer<typeof emailRegisterResult>;

/**
 * POST /auth/email/resend → body. Reenvía el código de verificación a una cuenta sin verificar.
 * Respuesta uniforme {sent:true} aunque la cuenta no exista o ya esté verificada (anti-enumeración).
 */
export const emailResend = z.object({ email: emailAddress });
export type EmailResend = z.infer<typeof emailResend>;

/** POST /auth/email/resend → respuesta: confirma el reenvío (reusa la forma de register). */
export const emailResendResult = emailRegisterResult;
export type EmailResendResult = EmailRegisterResult;

/** POST /auth/email/verify → body. Verifica el código emailado tras el registro. */
export const emailVerify = z.object({
  email: emailAddress,
  code: z.string().length(6),
});
export type EmailVerify = z.infer<typeof emailVerify>;

/** POST /auth/email/login → body. */
export const emailLogin = z.object({
  email: emailAddress,
  password: z.string().min(1, 'Contraseña requerida'),
});
export type EmailLogin = z.infer<typeof emailLogin>;

/** POST /auth/email/forgot → body. */
export const emailForgot = z.object({ email: emailAddress });
export type EmailForgot = z.infer<typeof emailForgot>;

/** POST /auth/email/forgot → respuesta: SIEMPRE {sent:true} (anti-enumeración). */
export const emailForgotResult = z.object({ sent: z.literal(true) });
export type EmailForgotResult = z.infer<typeof emailForgotResult>;

/** POST /auth/email/reset → body. Cambia la contraseña con el código de un solo uso. */
export const emailReset = z.object({
  email: emailAddress,
  code: z.string().length(6),
  newPassword: z
    .string()
    .min(EMAIL_PASSWORD_MIN, 'La contraseña debe tener al menos 12 caracteres'),
});
export type EmailReset = z.infer<typeof emailReset>;

/** POST /auth/email/reset → respuesta. */
export const emailResetResult = z.object({ ok: z.literal(true) });
export type EmailResetResult = z.infer<typeof emailResetResult>;

/**
 * Respuesta de verify/login por correo: tokens + sessionUser (misma forma que el OTP).
 * Reutiliza `mobileAuthTokens` (el shape es idéntico; lo aliasamos para legibilidad en el dominio).
 */
export const emailAuthTokens = mobileAuthTokens;
export type EmailAuthTokens = MobileAuthTokens;

/* ── Login con Google OAuth (ADR-012 Lote 3) ── */

/**
 * POST /auth/oauth/google → body. El cliente obtiene el `idToken` de Google Sign-In (nativo) y lo
 * envía; el backend lo verifica SOBERANAMENTE contra el JWKS de Google (firma+iss+aud+exp) y emite
 * tokens. La app nunca recibe ni maneja secretos de Google: solo reenvía el id_token.
 */
export const googleOAuth = z.object({
  idToken: z.string().min(1, 'idToken requerido'),
});
export type GoogleOAuth = z.infer<typeof googleOAuth>;

/** POST /auth/oauth/google → respuesta: tokens + sessionUser (misma forma que el OTP/correo). */
export const googleAuthTokens = mobileAuthTokens;
export type GoogleAuthTokens = MobileAuthTokens;

/* ── Login con Sign in with Apple (App Store Guideline 4.8) ── */

/**
 * POST /auth/oauth/apple → body. El cliente obtiene el `identityToken` de Sign in with Apple
 * (flujo nativo) y lo envía; el backend lo verifica SOBERANAMENTE contra el JWKS de Apple
 * (firma+iss+aud+exp) y emite tokens. La app nunca recibe ni maneja secretos de Apple: solo
 * reenvía el identityToken. Nota: Apple solo manda el email en el PRIMER login y el nombre nunca
 * viaja en el token; el backend resuelve el re-login por el `sub` estable.
 */
export const appleOAuth = z.object({
  identityToken: z.string().min(1, 'identityToken requerido'),
});
export type AppleOAuth = z.infer<typeof appleOAuth>;

/** POST /auth/oauth/apple → respuesta: tokens + sessionUser (misma forma que el OTP/correo). */
export const appleAuthTokens = mobileAuthTokens;
export type AppleAuthTokens = MobileAuthTokens;

/**
 * GET /auth/panic-key (JWT pasajero) → secreto HMAC COMPARTIDO de pánico + versión del mensaje
 * canónico. Modelo actual del servicio: secreto compartido (no per-user). El cliente firma con él
 * el cuerpo del POST /panic (BR-S04).
 */
export const panicKey = z.object({
  secret: z.string().min(1),
  version: z.string().min(1),
});
export type PanicKey = z.infer<typeof panicKey>;

/* ── Registro de device token (push) ── */

/** Plataforma del dispositivo para el envío de push. */
export const devicePlatform = z.enum(['ios', 'android']);
export type DevicePlatform = z.infer<typeof devicePlatform>;

/**
 * Registro/baja de token de push.
 *  - Pasajero: POST /devices · DELETE /devices/:token (public-bff).
 *  - Conductor: POST /notifications/device-token · DELETE /notifications/device-token/:token (driver-bff).
 * Ambos responden 204 (sin cuerpo).
 */
export const registerDevice = z.object({
  token: z.string().min(1),
  platform: devicePlatform,
});
export type RegisterDevice = z.infer<typeof registerDevice>;

/* ── Perfil del pasajero (/users/me) ── */

/**
 * Tipo de documento de identidad (DN=DNI · CE=carné de extranjería · PP=pasaporte). Vive en el PERFIL
 * para la afiliación Yape de UN TAP (patrón PedidosYa · ProntoPaga: documento en perfil, no en checkout).
 * Se define acá (1er uso) y se reusa en la afiliación Yape más abajo.
 */
export const documentType = z.enum(['DN', 'CE', 'PP']);
export type DocumentType = z.infer<typeof documentType>;

/** GET /users/me → perfil. */
export const passengerProfile = z.object({
  id: z.string(),
  /** Teléfono del pasajero; null si entró por correo/Google/Apple (no tiene teléfono). */
  phone: z.string().nullable(),
  type: z.string(),
  kycStatus: z.string(),
  /** Nombre visible del pasajero; null si aún no lo ha configurado. */
  name: z.string().nullable(),
  email: z.string().nullable(),
  photoUrl: z.string().nullable(),
  /**
   * Documento de identidad del pasajero para pagos (Yape On File · ProntoPaga). Vive en el PERFIL
   * (no en el checkout): se carga UNA vez y habilita la afiliación Yape de UN TAP. `null` si aún no
   * lo cargó. Es SU dato (owner-only por JWT); la UI decide cómo enmascararlo al mostrarlo.
   */
  documentType: documentType.nullable(),
  document: z.string().nullable(),
  /**
   * Método de pago por defecto del pasajero (preferencia de UI: siembra el selector al pedir viaje).
   * Vive en el backend (identity-service) → sobrevive reinstalación y multi-dispositivo. `null` si nunca
   * lo eligió: la app cae a su default local.
   */
  defaultPaymentMethod: mobilePaymentMethod.nullable(),
});
export type PassengerProfile = z.infer<typeof passengerProfile>;

/** PATCH /users/me → body (campos opcionales). */
export const updatePassengerProfile = z.object({
  /** Nombre visible del pasajero (1–80). */
  name: z.string().min(1).max(80).optional(),
  email: z.string().email().optional(),
  photoUrl: z.string().url().optional(),
  /**
   * Documento del pasajero (Yape On File). Va junto a `document`. El backend valida la forma SEGÚN el
   * tipo (DN=8 díg · CE 9-12 díg · PP 6-12 alfanum). Se guarda en el perfil para la afiliación de UN TAP.
   */
  documentType: documentType.optional(),
  document: z.string().min(6).max(20).optional(),
  /** Método de pago por defecto del pasajero (se asciende al marcar "recordar como predeterminado"). */
  defaultPaymentMethod: mobilePaymentMethod.optional(),
});
export type UpdatePassengerProfile = z.infer<typeof updatePassengerProfile>;

/* ── Vinculación de teléfono al perfil (phone-link) ── */

/**
 * POST /users/me/phone/request → body. Pide un OTP para vincular un teléfono al perfil del usuario
 * AUTENTICADO (típicamente entró por correo/Google/Apple y quedó sin teléfono). Reusa la infra OTP
 * del login (mismo TTL/cooldown/intentos). Errores: 409 `PHONE_TAKEN` si el número es de otro usuario
 * (anti-enumeración: no revela de quién); 429 `RATE_LIMIT` si pide demasiado pronto.
 */
export const requestPhoneLink = z.object({
  phone: z.string().regex(peruPhone, 'Teléfono peruano inválido'),
});
export type RequestPhoneLink = z.infer<typeof requestPhoneLink>;

/** POST /users/me/phone/request → respuesta. */
export const requestPhoneLinkResult = z.object({ sent: z.literal(true) });
export type RequestPhoneLinkResult = z.infer<typeof requestPhoneLinkResult>;

/**
 * POST /users/me/phone/verify → body. Verifica el OTP y vincula el teléfono. Mismos intentos/lockout
 * que el login OTP. Si el usuario ya tenía OTRO teléfono, lo REEMPLAZA. Devuelve el perfil actualizado
 * (`passengerProfile`, ya con el `phone`).
 */
export const verifyPhoneLink = z.object({
  phone: z.string().regex(peruPhone, 'Teléfono peruano inválido'),
  code: z.string().length(6),
});
export type VerifyPhoneLink = z.infer<typeof verifyPhoneLink>;

/* ── Subida del avatar (presigned upload a S3/MinIO) ── */

/** Content-Type de imagen aceptado para el avatar (lista blanca). */
export const avatarContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export type AvatarContentType = z.infer<typeof avatarContentType>;

/** Extensión de fichero aceptada para el avatar. */
export const avatarExtension = z.enum(['jpg', 'jpeg', 'png', 'webp']);
export type AvatarExtension = z.infer<typeof avatarExtension>;

/**
 * POST /users/me/avatar/presign → body. Pide un ticket de subida prefirmado para el avatar.
 * `ext` debe ser coherente con `contentType` (jpg/jpeg→image/jpeg, png→image/png, webp→image/webp).
 */
export const avatarUploadRequest = z.object({
  contentType: avatarContentType,
  ext: avatarExtension,
});
export type AvatarUploadRequest = z.infer<typeof avatarUploadRequest>;

/**
 * POST /users/me/avatar/presign → respuesta. Ticket de subida directa a S3/MinIO:
 *  1. La app sube el binario con un PUT a `uploadUrl` enviando los `headers` (incl. `Content-Type`).
 *     El binario NO debe exceder `maxBytes` (lo valida el backend en el confirm; el presign PUT no
 *     puede acotar el Content-Length).
 *  2. Tras el 200/204 del PUT, confirma con POST /users/me/avatar/confirm { key }: el backend valida
 *     la cuota de tamaño y, si excede, borra el objeto y responde 400.
 *  3. Con la confirmación OK, guarda `publicUrl` (URL pública estable) en su perfil con
 *     PATCH /users/me { photoUrl: publicUrl }.
 * El ticket caduca en `expiresInSeconds`.
 */
export const avatarUploadTicket = z.object({
  uploadUrl: z.string().url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  key: z.string(),
  publicUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
});
export type AvatarUploadTicket = z.infer<typeof avatarUploadTicket>;

/** POST /users/me/avatar/confirm → body. Confirma la subida con la `key` recibida en el ticket. */
export const avatarUploadConfirmRequest = z.object({
  key: z.string(),
});
export type AvatarUploadConfirmRequest = z.infer<typeof avatarUploadConfirmRequest>;

/**
 * POST /users/me/avatar/confirm → respuesta. La subida cumplió la cuota; `publicUrl` es la URL pública
 * estable lista para guardar en el perfil (PATCH /users/me { photoUrl: publicUrl }).
 */
export const avatarUploadConfirmed = z.object({
  key: z.string(),
  publicUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative(),
});
export type AvatarUploadConfirmed = z.infer<typeof avatarUploadConfirmed>;

/* ── Cotización (surge) ── */

/**
 * GET /dispatch/surge?lat&lon → multiplicador dinámico para estimar la tarifa antes de pedir.
 * La cotización firme se obtiene al crear el viaje (POST /trips devuelve fareCents/distance/duration/polyline).
 */
export const surgeQuote = z.object({
  multiplier: z.number(),
  zoneId: z.string(),
  active: z.boolean(),
});
export type SurgeQuote = z.infer<typeof surgeQuote>;

/* ── Conductores cercanos · feed de ambiente del mapa (dispatch-service) ── */

/**
 * Autito ANÓNIMO del mapa de "buscando": SOLO posición + tipo. NUNCA driverId/nombre/rating — son
 * vehículos de AMBIENTE, no identidades asignables. Las coords vienen REDONDEADAS (~110m) desde el
 * backend (anti-rastreo de trayectoria entre polls). `vehicleType` filtra el matching, no la identidad.
 */
export const nearbyVehicle = z.object({
  lat: z.number(),
  lon: z.number(),
  vehicleType: mobileVehicleType,
});
export type NearbyVehicle = z.infer<typeof nearbyVehicle>;

/**
 * GET /dispatch/nearby?lat&lon[&vehicleType] (JWT pasajero) → conductores disponibles cerca, anónimos,
 * para pintar autitos en el mapa mientras el pasajero busca. `vehicleType` opcional (CAR/MOTO) filtra;
 * ausente = todos. `vehicles: []` si no hay nadie cerca o el origen cae fuera de Lima.
 */
export const nearbyVehiclesView = z.object({
  vehicles: z.array(nearbyVehicle),
});
export type NearbyVehiclesView = z.infer<typeof nearbyVehiclesView>;

/* ── Mapas: búsqueda, reverse y cotización de previsualización (public-bff /maps/*) ── */

/**
 * Sugerencia del autocompletado (GET /maps/autocomplete?q&lat&lng → lista).
 * Coordenadas en `lat`/`lng` (convención del mapa MapLibre que usa la app). `[]` si q < 3 chars.
 */
export const placeSuggestion = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type PlaceSuggestion = z.infer<typeof placeSuggestion>;
export const placeSuggestionList = z.array(placeSuggestion);
export type PlaceSuggestionList = z.infer<typeof placeSuggestionList>;

/** Etiqueta de un punto (GET /maps/reverse?lat&lng → "Tu ubicación"). */
export const reversePlace = z.object({
  title: z.string(),
  subtitle: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type ReversePlace = z.infer<typeof reversePlace>;

/** Punto geográfico de la API de mapas (usa `lng`, no `lon`, para MapLibre). */
export const mapPoint = z.object({ lat: z.number(), lng: z.number() });
export type MapPoint = z.infer<typeof mapPoint>;

/** POST /maps/quote → body. `waypoints` (Ola 2B): paradas intermedias ordenadas (máx 3). */
export const quoteRequest = z.object({
  origin: mapPoint,
  destination: mapPoint,
  waypoints: z.array(mapPoint).max(3).optional(),
});
export type QuoteRequest = z.infer<typeof quoteRequest>;

/** Geometría GeoJSON (LineString, coords [lng, lat]) lista para pintar en MapLibre. */
export const geoJsonLineString = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(z.tuple([z.number(), z.number()])),
});
export type GeoJsonLineString = z.infer<typeof geoJsonLineString>;

/** Opción de viaje cotizada por oferta del catálogo (ADR 013; precio en céntimos PEN). */
export const quoteOption = z.object({
  id: z.string(),
  /** Nombre resuelto server-side (compat apps viejas; las nuevas resuelven `labelKey` en su i18n). */
  name: z.string(),
  /**
   * Tipo de vehículo de la categoría (Ola 2B). 'veo_moto' ⇒ MOTO; el resto CAR. La app debe enviar
   * este `vehicleType` en `createTripRequest` al elegir la opción para que el matching filtre por tipo.
   */
  vehicleType: mobileVehicleType,
  etaSeconds: z.number().int(),
  priceCents: z.number().int(),
  /**
   * Crédito de referido (Ola 2A · Lote C3) que se aplicaría a ESTA opción: `min(saldo, priceCents)`,
   * computado SERVER-side. La app muestra "se aplican S/X · pagás priceCents − X". Opcional: un server
   * viejo no lo manda (fallback: la app trata `undefined` como 0 = sin preview). PREVIEW sobre la tarifa
   * cotizada: si al cobrar hay promo, el crédito real puede ser menor; el recibo muestra el aplicado real.
   */
  creditAppliedCents: z.number().int().nonnegative().optional(),
  currency: z.literal('PEN'),
  /**
   * ADR 013 §1.3 (additive) · modo de pricing RESUELTO POR OFERTA (`offering.allowedModes` ∩ schedule
   * del admin): pinta la pantalla de puja o de precio firme POR opción. Opcional: un server viejo no
   * lo manda — fallback: el `mode` top-level del quote (ancla VEO Económico).
   */
  mode: pricingMode.optional(),
  /**
   * ADR 013 (additive) · token i18n del nombre (`offering.veo_moto.name`); la app lo resuelve en su
   * i18n. Opcional (server viejo) — fallback: `name` resuelto server-side.
   */
  labelKey: z.string().optional(),
  /**
   * ADR 013 (additive) · token de ícono (`car` | `moto`; futuro `ambulance`…) que la app resuelve en
   * su registro token→glyph. String ABIERTO a propósito: un token nuevo de un server más nuevo NO debe
   * romper el parse de una app vieja (su registro cae al glyph genérico).
   */
  icon: z.string().optional(),
  /**
   * ADR 013 (A2 · additive) · SOLO si ESTA oferta resuelve PUJA: piso de la zona en céntimos PEN. El bid
   * del pasajero no puede bajar de acá. Es PREVIEW/display — el piso autoritativo lo re-resuelve
   * trip-service al crear el viaje (la app NUNCA lo envía). Opcional: ausente si la oferta es FIXED, o si
   * el server es viejo (fallback: `quoteResult.bidFloorCents` top-level).
   */
  bidFloorCents: z.number().int().optional(),
  /**
   * ADR 013 (A2 · additive) · SOLO si ESTA oferta resuelve PUJA: ancla sugerida = la tarifa que SERÍA
   * fija DE ESTA oferta (su `priceCents`, calculado con SU multiplicador) — antes el sugerido era siempre
   * el del ancla VEO Económico (bug: en Moto/Confort anclaba al precio del auto). Opcional: ausente en
   * FIXED o server viejo (fallback: `quoteResult.suggestedCents` top-level).
   */
  suggestedCents: z.number().int().optional(),
});
export type QuoteOption = z.infer<typeof quoteOption>;

/**
 * POST /maps/quote → respuesta: ruta real (OSRM) + opciones de tarifa por categoría.
 * Es solo PREVISUALIZACIÓN; la cotización firme llega al crear el viaje (POST /trips).
 *
 * ADR 011 (M4) · `mode` le dice a la app QUÉ pantalla mostrar (lo resuelve el servidor, no el cliente):
 *  - FIXED → tarifa fija: usa `options[].priceCents` como el precio firme por categoría.
 *  - PUJA  → "proponé tu precio": usa `bidFloorCents` (piso de la zona, el bid no puede bajar de ahí) y
 *            `suggestedCents` (ancla sugerida = la tarifa que SERÍA fija, calculada con la fórmula base).
 * Ambos campos son opcionales porque solo aplican al modo PUJA; en FIXED no se envían. El modo es una
 * PISTA: el modo autoritativo se RE-RESUELVE al crear el viaje (entre quote y create pudo cambiar).
 */
export const quoteResult = z.object({
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  geometry: geoJsonLineString,
  options: z.array(quoteOption),
  /**
   * Modo de pricing resuelto por el servidor: decide la pantalla (PUJA vs FIXED). ADR 013: ancla la
   * oferta VEO Económico (compat); el modo POR oferta viaja en `options[].mode` (additive).
   */
  mode: pricingMode,
  /**
   * Solo PUJA · COMPAT/fallback (ancla VEO Económico): piso de la zona en céntimos PEN. A partir de A2
   * el piso PREFERIDO viaja POR oferta en `options[].bidFloorCents`; este top-level queda para apps
   * viejas. El bid del pasajero no puede ser menor.
   */
  bidFloorCents: z.number().int().optional(),
  /**
   * Solo PUJA · COMPAT/fallback (ancla VEO Económico): ancla sugerida en céntimos PEN. A partir de A2 el
   * sugerido PREFERIDO viaja POR oferta en `options[].suggestedCents` (cada oferta sugiere SU tarifa);
   * este top-level queda para apps viejas.
   */
  suggestedCents: z.number().int().optional(),
});
export type QuoteResult = z.infer<typeof quoteResult>;

/**
 * GET /maps/catalog → catálogo ACTIVO de ofertas para la teaser del Home (B1f · server-driven). Solo las
 * ofertas que el admin tiene HABILITADAS (ADR 013 · Fase B); SIN ruta → sin precio. La app resuelve el
 * `labelKey` en su i18n y el `icon` en su registro token→glyph (igual que en el quote).
 */
export const offeringTeaserItem = z.object({
  id: z.string(),
  /** Nombre resuelto server-side (compat; las apps nuevas usan `labelKey`). */
  name: z.string(),
  labelKey: z.string(),
  /** Token de ícono ABIERTO (`car` | `moto` | futuro `ambulance`…): un token nuevo NO rompe el parse. */
  icon: z.string(),
  // NOTA: NO validamos `vehicleType` acá — la teaser pinta el glyph desde `icon` y el nombre desde
  // `labelKey`, no usa la clase de vehículo. zod descarta el campo extra que mande el server (no validar
  // lo que no se consume, §5-bis). Así, además, una clase nueva (Fase C) NO rompe el parse de la teaser.
});
export type OfferingTeaserItem = z.infer<typeof offeringTeaserItem>;

export const catalogResult = z.object({
  offerings: z.array(offeringTeaserItem),
});
export type CatalogResult = z.infer<typeof catalogResult>;

/* ── Crear/cotizar viaje (POST /trips) ── */

export const createTripRequest = z.object({
  origin: geoPoint,
  destination: geoPoint,
  /**
   * Paradas intermedias ORDENADAS entre origen y destino (Ola 2B · paradas múltiples, máx 3). La
   * ruta y la tarifa firme las incluyen. Omitir = viaje directo.
   */
  waypoints: z.array(geoPoint).max(3).optional(),
  /**
   * Hora programada del viaje (Ola 2B · viajes programados, ISO-8601). Si se envía, el viaje nace
   * PROGRAMADO (estado SCHEDULED) y el scheduler lo activa a la hora. Ventana válida [≥15min, ≤7días].
   * Omitir = viaje inmediato.
   */
  scheduledFor: z.string().datetime().optional(),
  /**
   * Tipo de vehículo solicitado (Ola 2B · tier moto-taxi). Tómalo de `quoteOption.vehicleType` de la
   * opción elegida. Default CAR si se omite. MOTO ⇒ el viaje solo se ofrece a conductores con moto.
   */
  vehicleType: mobileVehicleType.optional(),
  paymentMethod: mobilePaymentMethod,
  /**
   * Categoría/opción de tarifa elegida en la cotización: el `quoteOption.id`
   * (p.ej. `veo_moto` | `veo_economico` | `veo_confort` | `veo_xl`). Opcional por compatibilidad N-2
   * (apps antiguas no lo envían), pero la app actual SIEMPRE manda el `selectedId`.
   */
  category: z.string().min(1).optional(),
  surgeMultiplier: z.number().min(1).max(2).optional(),
  childMode: z.boolean().optional(),
  childCode: z
    .string()
    .regex(/^\d{4,6}$/)
    .optional(),
  /**
   * Código de promoción opcional (Ola 2A). Si se envía, el public-bff lo propaga al cobro
   * (POST /payments/charge) y el descuento reduce SOLO lo que paga el pasajero; comisión y
   * propina quedan intactas. Valida antes con POST /promos/validate para previsualizar.
   */
  promoCode: z.string().min(1).max(64).optional(),
  /**
   * PUJA (ADR 010) · la tarifa que el pasajero OFRECE, en céntimos PEN. El servidor RE-RESUELVE el modo
   * (ADR 011): si resuelve PUJA, `bidCents` es OBLIGATORIO (sin él → 400 "falta tu oferta") y debe ser
   * ≥ `quoteResult.bidFloorCents`; si resuelve FIXED, se IGNORA y se cobra la tarifa calculada. Opcional
   * acá (la app solo lo manda cuando el quote dijo PUJA). Tope `999_900` (= BID_MAX_CENTS en @veo/utils;
   * el BFF re-valida autoritativo).
   */
  bidCents: z.number().int().min(1).max(999_900).optional(),
  /**
   * BE-2 · solicitudes especiales para el conductor (mascota/equipaje/silla de niño). Las ve ANTES de
   * aceptar. "Parada" no va acá: es un waypoint. Omitir = ninguna.
   */
  specialRequests: z.array(specialRequest).max(3).optional(),
});
export type CreateTripRequest = z.infer<typeof createTripRequest>;

/**
 * PUJA · OFERTA de un conductor vista por el PASAJERO (ADR 010 §4). El pasajero lista las ofertas de su
 * board (`GET /trips/:id/offers`) y elige una (`POST /trips/:id/offers/:driverId/accept`). Espejo del
 * `OfferView` del public-bff (offers.dto.ts). La oferta se identifica por `driverId` (una por conductor,
 * idempotente). `kind`: ACCEPT_PRICE = aceptó tu bid tal cual (`priceCents` == tu oferta) · COUNTER =
 * contraoferta (`priceCents` > tu oferta).
 */
export const offerVehicle = z.object({
  make: z.string(),
  model: z.string(),
  color: z.string(),
  plate: z.string(),
});
export type OfferVehicle = z.infer<typeof offerVehicle>;

export const offerView = z.object({
  tripId: z.string(),
  driverId: z.string(),
  kind: z.enum(['ACCEPT_PRICE', 'COUNTER']),
  priceCents: z.number().int().positive(),
  etaSeconds: z.number().int().nonnegative(),
  status: z.string(),
  /**
   * BE-1 · enriquecido por el BFF (identity/rating/fleet vía gRPC) para que el pasajero elija por
   * nombre/rating/vehículo. Opcional+nullable: tolera respuestas sin enriquecer (p.ej. el accept, que no
   * renderiza la card) y las ofertas EN VIVO del socket (sin enriquecer hasta el refetch REST).
   */
  driverName: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  ratingCount: z.number().int().nonnegative().optional(),
  vehicle: offerVehicle.nullable().optional(),
});
export type OfferView = z.infer<typeof offerView>;

/**
 * PUJA · ESTADO del board del pasajero (FIX contrato). 'GONE' = la key del board ya no existe en Redis
 * (expiró por TTL) — la app distingue una puja viva-sin-ofertas de una cancelada/expirada/cerrada/evaporada
 * sin adivinar por un array vacío. Los demás valores son los estados reales del board.
 *  - OPEN           → la puja sigue viva (puede haber 0..N ofertas en `offers`).
 *  - CANCELLED      → el pasajero canceló la puja (el VIAJE pasa a CANCELLED_BY_PASSENGER).
 *  - EXPIRED        → la ventana venció sin match (pantalla NoOffers, re-puja).
 *  - CLOSED_MATCHED → el pasajero ya eligió una oferta (match).
 *  - GONE           → el board ya no existe en Redis (TTL); tratar como puja terminada.
 */
export const clientBoardStatus = z.enum(['OPEN', 'CANCELLED', 'EXPIRED', 'CLOSED_MATCHED', 'GONE']);
export type ClientBoardStatus = z.infer<typeof clientBoardStatus>;

export const offersBoardView = z.object({
  status: clientBoardStatus,
  /** epoch(ms) de vencimiento de la ventana; null si el board ya no existe (GONE). */
  expiresAt: z.number().int().nullable(),
});
export type OffersBoardView = z.infer<typeof offersBoardView>;

/**
 * PUJA · respuesta de `GET /trips/:id/offers` (FIX contrato). CAMBIO DE SHAPE — antes era `OfferView[]`,
 * ahora es `{ board: { status, expiresAt }, offers: OfferView[] }`. La app lee `board.status` para saber el
 * estado de la puja y `board.expiresAt` para el countdown autoritativo (en vez del reloj local). `offers`
 * SÓLO trae ofertas PENDING con board OPEN; en cualquier otro estado (CANCELLED/EXPIRED/CLOSED_MATCHED/GONE)
 * va vacío — nunca ofertas zombies de una puja ya muerta.
 */
export const offerList = z.object({
  board: offersBoardView,
  offers: z.array(offerView),
});
export type OfferList = z.infer<typeof offerList>;

/**
 * PUJA · RE-PUJA (`POST /trips/:id/rebid`). Tras una puja sin ofertas (EXPIRED) o una reasignación
 * (REASSIGNING), el pasajero re-abre el board con una nueva tarifa (típicamente más alta). El servicio
 * re-valida estado + rango + ownership. Devuelve el `tripResource` con el board re-abierto.
 */
export const rebidRequest = z.object({
  bidCents: z.number().int().min(1).max(999_900),
});
export type RebidRequest = z.infer<typeof rebidRequest>;

/* ── Promos / cupones (pasajero) ── */

/** POST /promos/validate → body. Previsualiza el descuento de un cupón sobre una cotización. */
export const promoValidateRequest = z.object({
  code: z.string().min(1).max(64),
  /** Bruto cotizado del viaje en céntimos PEN sobre el que se calcula el descuento. */
  fareCents: z.number().int().min(0),
});
export type PromoValidateRequest = z.infer<typeof promoValidateRequest>;

/** Tipo de descuento de un cupón. */
export const promoKind = z.enum(['PERCENTAGE', 'FIXED']);
export type PromoKind = z.infer<typeof promoKind>;

/**
 * POST /promos/validate → respuesta. Previsualización del descuento de un cupón:
 *  - `valid:true`  → `discountCents` (céntimos PEN) a restar del total del pasajero.
 *  - `valid:false` → `reason` legible (inválido/expirado/agotado/no aplica).
 */
export const promoValidationView = z.object({
  code: z.string(),
  kind: promoKind,
  valid: z.boolean(),
  discountCents: z.number().int(),
  reason: z.string().optional(),
});
export type PromoValidationView = z.infer<typeof promoValidationView>;

/* ── Referidos (pasajero) ── */

/** GET /referrals/me → resumen del programa de referidos del usuario. */
export const referralSummary = z.object({
  /** Código de referido único del usuario (para compartir). */
  code: z.string(),
  /** Cuántos usuarios ha referido (vínculos creados). */
  referredCount: z.number().int(),
  /** Crédito acumulado por referidos completados (céntimos PEN). */
  rewardsEarnedCents: z.number().int(),
});
export type ReferralSummary = z.infer<typeof referralSummary>;

/** POST /referrals/redeem → body. Canjea el código de OTRO usuario (una sola vez, no el propio). */
export const redeemReferralRequest = z.object({
  code: z.string().min(4).max(32),
});
export type RedeemReferralRequest = z.infer<typeof redeemReferralRequest>;

/**
 * Recurso de viaje tal como lo devuelve trip-service (passthrough del public-bff en POST /trips,
 * cancel y destination). Es a la vez la cotización (fareCents/distance/duration/polyline).
 * `status` es el crudo del downstream (coincide con los valores de `tripStatus`).
 */
export const tripResource = z.object({
  id: z.string(),
  passengerId: z.string(),
  driverId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  status: z.string(),
  origin: geoPoint,
  destination: geoPoint,
  /** Paradas intermedias ordenadas (Ola 2B · paradas múltiples); `[]` si el viaje es directo. */
  waypoints: z.array(geoPoint),
  fareCents: z.number().int(),
  currency: z.string(),
  surgeMultiplier: z.number(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  paymentMethod: z.string(),
  routePolyline: z.string().nullable(),
  /** Categoría/opción de tarifa elegida por el pasajero (`quoteOption.id`); null si la app no la envió. */
  category: z.string().nullable(),
  /** Tipo de vehículo solicitado (Ola 2B · tier moto-taxi). */
  vehicleType: mobileVehicleType,
  /**
   * ADR 011 (M5/S1) — modo de despacho AUTORITATIVO del viaje (PUJA | FIXED), resuelto y CONGELADO por el
   * servidor al crear. Es el modo REAL del viaje (no el que mostró el quote): si el schedule flipeó entre
   * el quote y la creación, la app RECONCILIA contra este valor (refresca/avisa) en vez de mandar un bid
   * que un viaje FIXED ignoraría silenciosamente. Lo trae el POST /trips, el GET trip y la lista de reservas.
   */
  dispatchMode: pricingMode,
  /**
   * Hora programada (Ola 2B · viaje programado, ISO-8601); null si es inmediato. Si `status` es
   * `SCHEDULED`, el viaje aún no entró a dispatch (el scheduler lo activará a la hora).
   */
  scheduledFor: z.string().nullable(),
  childMode: z.boolean(),
  penaltyCents: z.number().int(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type TripResource = z.infer<typeof tripResource>;

/**
 * GET /trips/scheduled → lista de viajes PROGRAMADOS (estado SCHEDULED) del pasajero (Ola 2B),
 * ordenados por hora ascendente. Cada elemento es un `tripResource` (con `scheduledFor` no nulo).
 * Cancelar uno: DELETE /trips/:id/schedule (sin penalidad si es con antelación).
 */
export const scheduledTripList = z.array(tripResource);
export type ScheduledTripList = z.infer<typeof scheduledTripList>;

/* ── Vista del viaje activo (GET /trips/:id) ── */

export const tripDriverView = z.object({
  id: z.string(),
  /** Nombre visible del conductor (SEGURIDAD: confirmar a quién se sube); null si aún no lo tiene. */
  name: z.string().nullable(),
  status: z.string(),
  backgroundCheckStatus: z.string(),
  rating: z.number().nullable(),
  ratingCount: z.number().int(),
});
export type TripDriverView = z.infer<typeof tripDriverView>;

export const tripVehicleView = z.object({
  id: z.string(),
  plate: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  color: z.string(),
});
export type TripVehicleView = z.infer<typeof tripVehicleView>;

/**
 * Detalle agregado del viaje activo (estado + conductor + vehículo). La ubicación en vivo del
 * conductor, el ETA y la polyline llegan por el socket `/passenger` (`driver:location`, `eta`,
 * `trip:update`); la polyline inicial también viene en `tripResource.routePolyline`.
 */
export const tripActiveView = z.object({
  id: z.string(),
  status: tripStatus,
  passengerId: z.string(),
  fareCents: z.number().int(),
  currency: z.string(),
  /**
   * Propina acumulada del viaje (100% al conductor, fuera de comisión). La fuente autoritativa es el
   * pago (`paymentView`); aquí es 0 salvo que el detalle haya podido resolverlo.
   */
  tipCents: z.number().int(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  paymentMethod: z.string(),
  childMode: z.boolean(),
  penaltyCents: z.number().int(),
  /**
   * Re-entrada del cierre post-viaje: ISO-8601 de cuándo el pasajero selló el cierre, o null si aún sin
   * cerrar. La app NO re-ofrece el cierre de un viaje ya cerrado y refleja el estado real (p.ej. tras
   * un reload). En la vista activa normal es null; viene seteado en la respuesta de `POST /trips/:id/close`.
   */
  passengerClosedAt: z.string().nullable(),
  /**
   * Detalle de "Mis Viajes" (enriquecimiento server-side): la FECHA real del viaje, sin depender del
   * snapshot MMKV local. requestedAt SIEMPRE presente; completedAt/cancelledAt null si el viaje no llegó a
   * ese terminal. Nuevos campos NULLABLE → compat con los consumers actuales de la vista activa.
   */
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** Puntos del viaje ({lat,lng}, igual que `mapPoint`/historial; la app los pasa a {lat,lon} internamente). */
  origin: mapPoint,
  destination: mapPoint,
  /** Paradas intermedias ordenadas (Ola 2B); `[]` si directo. FUENTE ÚNICA: el server (no el borrador local). */
  waypoints: z.array(geoPoint),
  /**
   * Ruta del viaje codificada (polyline), persistida por el servidor; null si el viaje no la tiene. La app
   * pinta ESTA ruta en el mapa del detalle sin depender del snapshot MMKV; si es null degrada a línea recta
   * origen→destino. NO confundir con la polyline en vivo del socket (`trip:update`), que es para el viaje activo.
   */
  routePolyline: z.string().nullable(),
  driver: tripDriverView.nullable(),
  vehicle: tripVehicleView.nullable(),
  /**
   * MI calificación (estrellas 1..5) de ESTE viaje: la que el pasajero le dio al conductor, o null si aún
   * no calificó. Enriquecido por el BFF (1 call extra best-effort) para que el detalle y la re-entrada del
   * cierre pinten el estado del rating SIN un GET aparte. La lista de "Mis Viajes" (por-item) sí usa
   * `GET /ratings?tripId` (ver `myRatingView`). Best-effort: null si rating-service estaba caído.
   */
  myRatingStars: z.number().int().nullable(),
});
export type TripActiveView = z.infer<typeof tripActiveView>;

/**
 * GET /trips/pending-settlement → cierre post-viaje PENDIENTE (re-entrada). Es el último viaje
 * COMPLETED del pasajero que aún NO cerró (recibo + confirmar efectivo + rating). Mismo detalle
 * agregado que la vista activa (estado + conductor + vehículo): tras un reload, COMPLETED es terminal
 * y `GET /trips/active` ya no lo devuelve, así que la app re-ofrece el cierre desde acá. El BFF
 * responde 200 + `tripActiveView` si hay pendiente, o 204 No Content si no (la app mapea 204 → null).
 * Cerrar: `POST /trips/:id/close`; el recibo del cobro: `GET /payments/by-trip/:tripId`.
 */
export const pendingSettlementView = tripActiveView;
export type PendingSettlementView = z.infer<typeof pendingSettlementView>;

/**
 * POST /trips/:id/close → cierra el post-viaje de un viaje COMPLETED (re-entrada). IDEMPOTENTE: cerrar
 * dos veces es ok. NO cambia el estado del viaje (sigue COMPLETED): `passengerClosedAt` es un flag de UX,
 * no un estado. Tras esto el viaje deja de aparecer en `GET /trips/pending-settlement`. Responde el
 * detalle agregado del viaje (mismo shape que la vista activa). Sin body.
 */
export const closeTripView = tripActiveView;
export type CloseTripView = z.infer<typeof closeTripView>;

/** GET /trips/:id/state → estado ligero (polling). */
export const tripStateView = z.object({ id: z.string(), status: tripStatus });
export type TripStateView = z.infer<typeof tripStateView>;

/* ── Historial de viajes (GET /trips/history?cursor=&limit=) ── */

/** Punto geo de la card del historial ({lat,lng}, como los `mapPoint` de la app). */
const historyGeoPoint = z.object({ lat: z.number(), lng: z.number() });

/**
 * Un viaje en el historial del pasajero ("Mis Viajes"). Trae el ESTADO REAL del servidor
 * (COMPLETED / CANCELLED / EXPIRED): la lista local de la app (MMKV) tiene una foto vieja con todo en
 * REQUESTED; ESTA es la fuente de verdad. ALIMENTA el detalle (GET /trips/:id) con el estado real, NO lo
 * reemplaza. SIN nombre de conductor (anti-N+1 en la lista): trae solo `driverId`; el nombre/rating del
 * conductor lo resuelve el DETALLE on-demand cuando el pasajero abre un viaje. La card pinta
 * tier+ruta+monto+estado con lo que viene acá, sin un lookup extra por item.
 */
export const tripHistoryItem = z.object({
  id: z.string(),
  status: tripStatus,
  origin: historyGeoPoint,
  destination: historyGeoPoint,
  fareCents: z.number().int(),
  currency: z.string(),
  paymentMethod: z.string(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  /** ISO-8601, siempre presente (orden DESC por este campo). */
  requestedAt: z.string(),
  /** ISO-8601 o null si el viaje no llegó a COMPLETED. */
  completedAt: z.string().nullable(),
  /** ISO-8601 o null si el viaje no fue cancelado. */
  cancelledAt: z.string().nullable(),
  /** null si el viaje nunca tuvo conductor (EXPIRED). El nombre se resuelve en el detalle. */
  driverId: z.string().nullable(),
  /** Tier solicitado (CAR|MOTO). */
  vehicleType: mobileVehicleType,
  /** Categoría/opción elegida (quoteOption.id); null si no se eligió. */
  category: z.string().nullable(),
});
export type TripHistoryItem = z.infer<typeof tripHistoryItem>;

/**
 * Página del historial: items + cursor de la SIGUIENTE página (`null` cuando no hay más). Paginación por
 * CURSOR (keyset), no offset: el cliente vuelve a llamar con `nextCursor` hasta que sea `null`. El cursor
 * es OPACO (token); la app no lo parsea.
 */
export const tripHistoryPage = z.object({
  items: z.array(tripHistoryItem),
  nextCursor: z.string().nullable(),
});
export type TripHistoryPage = z.infer<typeof tripHistoryPage>;

/** Opciones de `getTripHistory`: cursor de la página previa y tamaño de página (el servidor lo acota). */
export interface TripHistoryQuery {
  cursor?: string;
  limit?: number;
}

/**
 * GET /trips/history → una página del historial REAL del pasajero (estados COMPLETED/CANCELLED/EXPIRED),
 * ordenado por requestedAt DESC y paginado por cursor. El passengerId lo deriva el BFF del JWT (el cliente
 * NO lo manda: anti-IDOR). Valida la respuesta con `tripHistoryPage`. Uso:
 *   let cursor: string | undefined;
 *   do { const page = await getTripHistory(http, { cursor }); ...; cursor = page.nextCursor ?? undefined; }
 *   while (cursor);
 */
export function getTripHistory(
  http: {
    get<T>(
      path: string,
      opts?: {
        query?: Record<string, string | number | boolean | undefined>;
        schema?: z.ZodType<T>;
      },
    ): Promise<T>;
  },
  query: TripHistoryQuery = {},
): Promise<TripHistoryPage> {
  return http.get<TripHistoryPage>('/trips/history', {
    query: { cursor: query.cursor, limit: query.limit },
    schema: tripHistoryPage,
  });
}

/**
 * Bandeja de notificaciones in-app del pasajero. La notificación llega YA RENDERIZADA por el
 * notification-service (título + cuerpo interpolados desde la plantilla i18n) y categorizada: el
 * cliente NUNCA ve la key interna del template, solo su `category` (para ícono/tono). Sin estado
 * leído/no-leído por ahora (MVP cronológico — el `read_at` real es un follow-up).
 */
export const notificationCategory = z.enum(['trip', 'safety', 'payment', 'promo', 'general']);
export type NotificationCategory = z.infer<typeof notificationCategory>;

export const appNotification = z.object({
  id: z.string(),
  /** Familia del aviso: define ícono/tono en la app. */
  category: notificationCategory,
  /** Título ya renderizado. */
  title: z.string(),
  /** Cuerpo ya renderizado. */
  body: z.string(),
  /** ISO-8601 de emisión (orden DESC por este campo). */
  createdAt: z.string(),
});
export type AppNotification = z.infer<typeof appNotification>;

/** Opciones de `getNotifications`: tamaño de página (el servidor lo acota a 1..100). */
export interface NotificationsQuery {
  limit?: number;
}

/**
 * GET /notifications → bandeja in-app del pasajero (SUS notificaciones PUSH renderizadas, recientes
 * primero). El recipientId lo deriva el BFF del JWT (el cliente NO lo manda: anti-IDOR). Valida la
 * respuesta con `appNotification`.
 */
export function getNotifications(
  http: {
    get<T>(
      path: string,
      opts?: {
        query?: Record<string, string | number | boolean | undefined>;
        schema?: z.ZodType<T>;
      },
    ): Promise<T>;
  },
  query: NotificationsQuery = {},
): Promise<AppNotification[]> {
  return http.get<AppNotification[]>('/notifications', {
    query: { limit: query.limit },
    schema: z.array(appNotification),
  });
}

/** POST /trips/:id/cancel → body. */
export const cancelTripRequest = z.object({ reason: z.string().optional() });
export type CancelTripRequest = z.infer<typeof cancelTripRequest>;

/** POST /trips/:id/destination → body. */
export const changeDestinationRequest = z.object({ destination: geoPoint });
export type ChangeDestinationRequest = z.infer<typeof changeDestinationRequest>;

/**
 * Lote C2 · PARADA mid-trip NEGOCIADA — contrato cliente↔BFF.
 *
 * Estado de una propuesta de parada. ESPEJA el enum de dominio de trip-service (única fuente de verdad
 * del lado servidor). Se expone TIPADO al cliente para que las apps NO comparen strings mágicos
 * (§4-ter): branchean con los predicados de abajo o contra `WaypointProposalStatus.ACCEPTED`, jamás
 * contra `=== 'ACCEPTED'`. `PROPOSED` es el único estado VIVO; el resto son terminales.
 */
export const WaypointProposalStatus = {
  PROPOSED: 'PROPOSED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export const waypointProposalStatus = z.nativeEnum(WaypointProposalStatus);
export type WaypointProposalStatus = z.infer<typeof waypointProposalStatus>;

/** ¿La propuesta sigue VIVA (esperando respuesta del conductor)? Solo PROPOSED lo está. */
export function isProposalLive(status: WaypointProposalStatus): boolean {
  return status === WaypointProposalStatus.PROPOSED;
}
/** ¿La propuesta fue ACEPTADA (ruta+tarifa cambian)? */
export function isProposalAccepted(status: WaypointProposalStatus): boolean {
  return status === WaypointProposalStatus.ACCEPTED;
}

/**
 * POST /trips/:id/waypoints → el PASAJERO PROPONE una parada durante el viaje (IN_PROGRESS). El cuerpo
 * SOLO transporta el punto: el passengerId lo estampa el BFF desde la identidad autenticada (anti-IDOR);
 * el delta de tarifa y la ruta nueva los calcula el server (server-authoritative, el cliente no fija precio).
 */
export const proposeWaypointRequest = z.object({ point: geoPoint });
export type ProposeWaypointRequest = z.infer<typeof proposeWaypointRequest>;

/**
 * Respuesta de la PROPUESTA: lo que la app del pasajero muestra en la confirmación (delta a pagar, tarifa
 * nueva, ETA nuevo, hasta cuándo vive la propuesta). Espeja `ProposeWaypointResult` de trip-service.
 */
export const waypointProposalView = z.object({
  proposalId: z.string(),
  deltaFareCents: z.number().int(),
  newFareCents: z.number().int(),
  newEtaSeconds: z.number(),
  expiresAt: z.string(),
});
export type WaypointProposalView = z.infer<typeof waypointProposalView>;

/**
 * POST /trips/:id/waypoints/:proposalId/respond → el CONDUCTOR acepta/rechaza. El cuerpo SOLO transporta
 * `accept`: el driverId lo DERIVA el BFF server-side (anti-IDOR), el cliente no lo envía.
 */
export const respondWaypointRequest = z.object({ accept: z.boolean() });
export type RespondWaypointRequest = z.infer<typeof respondWaypointRequest>;

/**
 * Resultado de RESPONDER la propuesta: estado terminal (ACCEPTED/REJECTED) + tarifa VIGENTE del viaje
 * (la nueva si aceptó, la misma si rechazó). Server-authoritative. Espeja `RespondWaypointResult`.
 */
export const respondWaypointView = z.object({
  proposalId: z.string(),
  status: waypointProposalStatus,
  fareCents: z.number().int(),
});
export type RespondWaypointView = z.infer<typeof respondWaypointView>;

/**
 * OUTCOME en VIVO de una propuesta (server → PASAJERO por socket `/passenger`, evento `waypoint:outcome`,
 * Lote C4): el conductor respondió o la propuesta venció. `status` es TERMINAL (ACCEPTED/REJECTED/EXPIRED
 * — nunca PROPOSED). NO trae tarifa: en ACCEPTED la app refetchea el detalle (ruta+paradas+tarifa nuevas,
 * fuente única del servidor); en REJECTED/EXPIRED el viaje sigue igual. La app cierra el "esperando" con esto.
 */
export const waypointProposalOutcome = z.object({
  proposalId: z.string(),
  status: waypointProposalStatus,
});
export type WaypointProposalOutcome = z.infer<typeof waypointProposalOutcome>;

/**
 * Propuesta de parada que el CONDUCTOR recibe en vivo (server → /driver, evento `waypoint:proposed`,
 * Lote C4): el pasajero propuso una parada en su viaje EN CURSO. El conductor ve el punto, el costo
 * adicional y la tarifa nueva (calculados por el server) y el vencimiento, y acepta/rechaza vía
 * `POST /trips/:id/waypoints/:proposalId/respond` antes de `expiresAt`.
 */
export const waypointProposedMsg = z.object({
  proposalId: z.string(),
  tripId: z.string(),
  point: geoPoint,
  deltaFareCents: z.number().int(),
  newFareCents: z.number().int(),
  expiresAt: z.string(),
});
export type WaypointProposedMsg = z.infer<typeof waypointProposedMsg>;

/**
 * GET /trips/:id/video → token viewer LiveKit (solo suscripción) del habitáculo de SU viaje en curso.
 * Si LiveKit no está configurado o el viaje no está IN_PROGRESS, el BFF responde 404/403 y la app
 * degrada a "sin video". Nunca se inventan credenciales en el cliente.
 */
export const tripVideoGrant = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  roomName: z.string().optional(),
});
export type TripVideoGrant = z.infer<typeof tripVideoGrant>;

/* ── Pánico (POST /panic) ── */

export const panicTriggerRequest = z.object({
  tripId: z.string().uuid(),
  dedupKey: z.string().uuid(),
  geo: geoPoint,
  signature: z.string(),
});
export type PanicTriggerRequest = z.infer<typeof panicTriggerRequest>;

export const panicTriggerResult = z.object({
  panicId: z.string(),
  status: z.string(),
  deduplicated: z.boolean(),
  triggeredAt: z.string(),
  evidenceS3Keys: z.array(z.string()),
});
export type PanicTriggerResult = z.infer<typeof panicTriggerResult>;

/** GET /panic/:id → estado de la alerta. */
export const panicView = z.object({
  id: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  status: z.string(),
  geo: geoPoint,
  triggeredAt: z.string(),
  acknowledgedAt: z.string().nullable(),
});
export type PanicView = z.infer<typeof panicView>;

/* ── Compartir viaje con familia (BR-S05) ── */

/**
 * POST /share/:tripId → body. Crea un enlace de seguimiento firmado para un viaje EN CURSO.
 * Espeja `CreateShareLinkDto` de public-bff. Todos los campos son opcionales:
 *  - `contactId`: ata el enlace a un contacto de confianza concreto (UUID).
 *  - `ttlSeconds`: TTL del enlace (60..86400 s); el backend aplica su default si se omite.
 *  - `maxUses`: máximo de aperturas permitidas (1..10000).
 */
export const shareTripRequest = z.object({
  contactId: z.string().uuid().optional(),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
});
export type ShareTripRequest = z.infer<typeof shareTripRequest>;

/**
 * POST /share/:tripId → respuesta. Enlace de seguimiento recién creado.
 * Espeja `CreatedShareLink` de public-bff (incluido `deduped`). `url` es la URL pública
 * (family-web) que el pasajero comparte; `token` es el token firmado embebido en ella
 * (sirve para revocar/identificar).
 */
export const createdShareLink = z.object({
  shareId: z.string(),
  token: z.string(),
  /** URL pública de seguimiento (family-web) lista para compartir. */
  url: z.string(),
  tripId: z.string(),
  contactId: z.string().nullable(),
  /** Caducidad del enlace (ISO-8601). */
  expiresAt: z.string(),
  maxUses: z.number().int(),
  /**
   * true si el enlace ya existía (dedup por dedupKey en share-service); en ese caso NO se reenvía
   * el SMS. Optional (no `.nullable()`) a propósito: additive — apps viejas que no lo conocen y
   * respuestas de BFFs previos a la unificación siguen parseando.
   */
  deduped: z.boolean().optional(),
});
export type CreatedShareLink = z.infer<typeof createdShareLink>;

/**
 * POST /share/:shareId/revoke → respuesta. Revoca el enlace de seguimiento de la sesión actual
 * (kill-switch del pasajero): la página pública deja de servir la ubicación al instante. Idempotente
 * en el server (revocar un enlace ya revocado devuelve su `revokedAt` original). Additive: apps viejas
 * que no conocen el endpoint siguen funcionando.
 */
export const revokedShareLink = z.object({ revokedAt: z.string() });
export type RevokedShareLink = z.infer<typeof revokedShareLink>;

/* ── Pagos (pasajero) ── */

export const chargeRequest = z.object({
  tripId: z.string().uuid(),
  grossCents: z.number().int().min(0),
  tipCents: z.number().int().min(0).optional(),
  method: mobilePaymentMethod,
  payerRef: z.string().optional(),
  dedupKey: z.string().optional(),
});
export type ChargeRequest = z.infer<typeof chargeRequest>;

/**
 * POST /trips/:id/tip → body. Propina del pasajero a SU viaje ya cobrado (BR-P04): 100% al conductor,
 * fuera de comisión. Idempotente en el BFF (deriva la dedupKey de passenger+trip+monto). Responde un
 * `paymentView` con el `tipCents`/`amountCents` ya acumulados.
 */
export const addTipRequest = z.object({
  tipCents: z.number().int().min(1),
});
export type AddTipRequest = z.infer<typeof addTipRequest>;

/**
 * Estado de un pago. Espeja `PaymentStatus` de @veo/shared-types (el public-bff lo pasa 1:1 desde
 * payment-service). Tiparlo (no `z.string()`) evita comparar contra un literal inexistente: el estado
 * "pagado" es CAPTURED, NUNCA 'PAID' (PaymentStatus no tiene 'PAID').
 */
export const paymentStatus = z.enum([
  'PENDING',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DEBT',
]);

/** Vista de pago del pasajero (POST /payments/charge, GET /payments/:id, cash/confirm, POST /trips/:id/tip). */
export const paymentView = z.object({
  id: z.string(),
  tripId: z.string(),
  method: z.string(),
  status: paymentStatus,
  amountCents: z.number().int(),
  grossCents: z.number().int(),
  /** Propina acumulada del viaje (100% al conductor, fuera de comisión). */
  tipCents: z.number().int(),
  commissionCents: z.number().int(),
  feeCents: z.number().int(),
  externalRef: z.string(),
  /**
   * Checkout asíncrono (ProntoPaga). Presentes SOLO cuando el cobro espera pago fuera de banda y el
   * `status` es PENDING hasta el webhook de captura. `null` para cobros sin checkout (efectivo, Yape
   * on-file ya capturado, sandbox). NUNCA incluye walletUid.
   *  - `checkoutUrl`: URL del widget de pago hospedado.
   *  - `qrCode`: data-URI del QR (`data:image/png;base64,...`) para Yape/Plin.
   *  - `deepLink`: abre la app del wallet para aprobar/pagar.
   *  - `cip`: código CIP de PagoEfectivo (pago en agente/banca).
   *  - `checkoutExpiresAt`: caducidad del checkout (ISO-8601).
   */
  externalUid: z.string().nullable().optional(),
  checkoutUrl: z.string().nullable().optional(),
  qrCode: z.string().nullable().optional(),
  deepLink: z.string().nullable().optional(),
  cip: z.string().nullable().optional(),
  checkoutExpiresAt: z.string().nullable().optional(),
  /**
   * Razón ESTRUCTURADA del fallo del cobro (cuando `status` = DEBT). `null` si no hubo fallo. Cuando el
   * método NO está habilitado en el comercio llega `method_unavailable:<METHOD>` (p.ej.
   * `method_unavailable:PAGOEFECTIVO`): la app muestra "PagoEfectivo no está disponible ahora, elegí
   * otro método" en vez del genérico, SIN dejar al usuario en loop. Otros valores: el motivo del riel
   * (declined, yape_insufficient_funds…). Nullable/opcional ⇒ compat con clientes viejos.
   */
  failureReason: z.string().nullable().optional(),
});
export type PaymentView = z.infer<typeof paymentView>;

/**
 * GET /payments/by-trip/:tripId → cobro CANÓNICO de un viaje (re-entrada del recibo). Resuelve el
 * Payment del cobro del viaje (auto-cobrado al completar). ANTI-IDOR: el BFF responde 404 si el viaje
 * no es del pasajero autenticado o no existe; 404 si el viaje aún no tiene cobro. Mismo `paymentView`
 * que `GET /payments/:id`: incluye `tipCents`/`amountCents` acumulados y el `status` (p.ej. CAPTURED,
 * o PENDING si es efectivo esperando la confirmación bilateral vía `POST /payments/:id/cash/confirm`).
 */
export const paymentByTripView = paymentView;
export type PaymentByTripView = z.infer<typeof paymentByTripView>;

/**
 * Clase de un ítem accionable del pasajero:
 *  - `DEBT`: un cobro en status=DEBT (reintentos agotados). BLOQUEA pedir un viaje nuevo (gate del BFF)
 *    → la franja del home dice "Tienes un pago pendiente · S/X — Resolver".
 *  - `PENDING_ACTION`: un cobro PENDING con un checkout VIVO (ProntoPaga) esperando que el usuario
 *    complete el pago (deepLink Yape / urlPay / QR / CIP). NO es deuda y NO bloquea: es un "pago por
 *    completar" que, si el usuario cerró el sheet, quedaba sin camino de vuelta → la franja dice
 *    "Tienes un pago por completar — Continuar" y abre DIRECTO el checkout del payment.
 */
export const debtItemKind = z.enum(['DEBT', 'PENDING_ACTION']);
export type DebtItemKind = z.infer<typeof debtItemKind>;

/**
 * Un ítem accionable del pasajero (un cobro en DEBT o un PENDING con checkout vivo). Para la franja del
 * home y el sheet. `reason` es la razón del fallo del cobro (saldo insuficiente, declinado…) en DEBT, y
 * cadena vacía en PENDING_ACTION; montos en céntimos PEN.
 */
export const debtItemView = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  amountCents: z.number().int(),
  reason: z.string(),
  /** Fecha de creación del cobro (ISO-8601). */
  createdAt: z.string(),
  /**
   * DEBT (deuda, bloquea) o PENDING_ACTION (pago por completar, no bloquea). REQUERIDO en el contrato:
   * el BFF SIEMPRE lo emite (default DEBT para un payment-service viejo se resuelve allá, no acá), así el
   * tipo de salida no diverge del de entrada (evita el desajuste input/output de un `.default()` en zod).
   */
  kind: debtItemKind,
});
export type DebtItemView = z.infer<typeof debtItemView>;

/**
 * GET /payments/debts → ítems accionables del pasajero autenticado (franja del home). `hasDebt` y
 * `totalCents` resumen SOLO las DEUDAS reales (kind=DEBT): mientras `hasDebt=true`, el gate del BFF
 * bloquea pedir un viaje nuevo (403 `DEBT_PENDING`). `debts` incluye ADEMÁS los PENDING_ACTION (pagos
 * por completar), que NO bloquean ni suman. Para SALDAR una deuda, la app hace
 * `POST /payments/:paymentId/retry-charge` (`retryCharge`) → `paymentView` (ProntoPaga vuelve PENDING
 * con checkout nuevo; sandbox/live vuelve CAPTURED o de vuelta a DEBT). Para CONTINUAR un PENDING_ACTION
 * la app lee el cobro fresco con `GET /payments/:id` y muestra su checkout.
 */
export const debtView = z.object({
  hasDebt: z.boolean(),
  totalCents: z.number().int(),
  debts: z.array(debtItemView),
});
export type DebtView = z.infer<typeof debtView>;

/**
 * Saldo de crédito GASTABLE del pasajero (redención de referidos · Ola 2A). `GET /payments/credit`.
 * Se aplica AUTOMÁTICAMENTE como descuento en el cobro del próximo viaje (lo hace el server, no la app).
 */
export const userCreditView = z.object({
  /** Saldo disponible en céntimos PEN (≥ 0). */
  balanceCents: z.number().int().nonnegative(),
});
export type UserCreditView = z.infer<typeof userCreditView>;

/**
 * POST /payments/:id/retry-charge → re-cobra un cobro en DEBT del pasajero (saldar deuda).
 * Sin body. Ownership server-side: 404 si el cobro no es del pasajero autenticado (anti-enumeración).
 * Respuesta: `paymentView` (mismo contrato que `GET /payments/:id`). Idempotente: re-disparar sobre un
 * cobro ya CAPTURED devuelve el estado actual sin re-cobrar.
 */
export const retryChargeView = paymentView;
export type RetryChargeView = z.infer<typeof retryChargeView>;

/**
 * Métodos DIGITALES a los que se puede cambiar un pago pendiente. CASH queda FUERA: el efectivo se
 * salda por confirmación bilateral con el conductor presente (BR-P03), no aplica a un pendiente post-viaje.
 */
export const mobileDigitalPaymentMethod = z.enum(['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO']);
export type MobileDigitalPaymentMethod = z.infer<typeof mobileDigitalPaymentMethod>;

/**
 * POST /payments/:id/method → body. DECISIÓN DEL DUEÑO: un pago PENDING/DEBT de un viaje YA HECHO que el
 * usuario no pudo pagar (no le anduvo el Yape) puede CAMBIAR de método (elige otro DIGITAL) sin rehacer
 * el viaje. SOLO métodos digitales (`mobileDigitalPaymentMethod`): CASH → 400 (BFF) / 422 (servicio).
 */
export const changePaymentMethodRequest = z.object({
  method: mobileDigitalPaymentMethod,
});
export type ChangePaymentMethodRequest = z.infer<typeof changePaymentMethodRequest>;

/**
 * POST /payments/:id/method → re-cobra el pago con el método NUEVO. Respuesta: `paymentView` (mismo
 * contrato que `GET /payments/:id`). ProntoPaga → status PENDING con CHECKOUT NUEVO del método nuevo
 * (deepLink/qrCode/checkoutUrl/cip cambian); sandbox/live → CAPTURED o de vuelta a DEBT.
 * Ownership server-side: 404 si el pago no es del pasajero autenticado (anti-enumeración).
 * Guards de negocio: 409 si el pago ya está CAPTURED/REFUNDED ("ya no se puede cambiar"); 422 si se
 * pidiera CASH. Idempotente: pedir el método ACTUAL devuelve el estado vigente sin re-cobrar.
 * IMPORTANTE: cambia SOLO cómo se liquida el Payment AHORA; NO altera el método HISTÓRICO del viaje
 * (`trip.paymentMethod`, lo que el pasajero eligió al pedir).
 */
export const changePaymentMethodView = paymentView;
export type ChangePaymentMethodView = z.infer<typeof changePaymentMethodView>;

/** POST /payments/:id/cash/confirm → body. */
export const cashConfirmRequest = z.object({ confirmed: z.boolean().optional() });
export type CashConfirmRequest = z.infer<typeof cashConfirmRequest>;

/* ── Afiliación Yape On File (pasajero · ProntoPaga) ── */

/**
 * POST /payments/affiliations/yape → body. Alta de Yape On File de UN TAP (patrón PedidosYa · ProntoPaga:
 * documento en PERFIL, nunca en checkout). El body es TODO OPCIONAL:
 *  - Body VACÍO ({})  → el BFF lee documento+nombre del PERFIL y afilia directo (UN TAP). El flujo feliz.
 *  - Body con {documentType, document} → el BFF PRIMERO guarda esos datos en el perfil y luego afilia
 *    (primera vez que el usuario carga su documento). Si se manda uno, mandá AMBOS.
 * El userId sale del JWT; el nombre del titular sale del perfil (nunca del body); origin=MOBILE.
 * Errores 422 con `code` distinguible en el shape estándar { error: { code, message, ... } }:
 *  - PROFILE_NAME_MISSING     → el perfil no tiene nombre: pedí PATCH /users/me { name }.
 *  - PROFILE_DOCUMENT_MISSING → el perfil no tiene documento: pedí { documentType, document } y reintentá.
 */
export const createYapeAffiliation = z
  .object({
    documentType: documentType.optional(),
    document: z.string().min(6).max(20).optional(),
  })
  .optional();
export type CreateYapeAffiliation = z.infer<typeof createYapeAffiliation>;

/**
 * Vista de la afiliación Yape. GET /payments/affiliations/yape devuelve `{status:'NONE'}` si no afilió,
 * o `{affiliationId, status, wallet, phoneMasked}`. POST devuelve además `deepLink` (aprobar en la app
 * Yape). DELETE devuelve `{affiliationId, status:'REVOKED', wallet, phoneMasked}`. NUNCA trae walletUid.
 */
export const yapeAffiliationView = z.object({
  affiliationId: z.string().optional(),
  /** NONE | PROCESS | ACTIVE | EXPIRED | REVOKED. */
  status: z.string(),
  wallet: z.string().optional(),
  phoneMasked: z.string().nullable().optional(),
  /** Solo en el alta: deep-link para aprobar la afiliación en la app Yape. */
  deepLink: z.string().optional(),
});
export type YapeAffiliationView = z.infer<typeof yapeAffiliationView>;

/**
 * DELETE /payments/affiliations/yape → baja (revocación local). Misma forma que `yapeAffiliationView`
 * con `status:'REVOKED'`. Se expone como alias semántico para la app.
 */
export const revokeYapeAffiliation = yapeAffiliationView;
export type RevokeYapeAffiliation = z.infer<typeof revokeYapeAffiliation>;

/* ── Calificaciones (pasajero) ── */

export const ratingSubmitRequest = z.object({
  tripId: z.string().uuid(),
  ratedId: z.string().uuid(),
  ratedRole: z.enum(['DRIVER', 'PASSENGER']),
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});
export type RatingSubmitRequest = z.infer<typeof ratingSubmitRequest>;

export const ratingView = z.object({
  id: z.string(),
  tripId: z.string(),
  raterId: z.string(),
  ratedId: z.string(),
  stars: z.number().int(),
  comment: z.string().nullable(),
  createdAt: z.string(),
});
export type RatingView = z.infer<typeof ratingView>;

/**
 * GET /ratings?tripId → MI calificación de un viaje: la que ESTE pasajero le dio al conductor.
 * El BFF responde 200 + este objeto si ya calificó, o 204 No Content si aún no (el HttpClient mapea
 * 204 → null). Contrato de la app: `getMyRatingForTrip(tripId) → MyRatingView | null`.
 *
 * Filtrado server-side por el rater autenticado (anti-IDOR): un pasajero NUNCA obtiene el rating de otro
 * ni el que el conductor le puso a él. Usalo para: el detalle de "Mis Viajes", el indicador "ya
 * calificaste" en la lista (por-item), y la re-entrada del rating. En el detalle activo / pending-
 * settlement, `tripActiveView.myRatingStars` ya trae las estrellas enriquecidas (sin este GET extra).
 */
export const myRatingView = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  createdAt: z.string(),
});
export type MyRatingView = z.infer<typeof myRatingView>;

/** GET /ratings/aggregate/:subjectId → agregado rolling 30d. */
export const ratingAggregateView = z.object({
  subjectId: z.string(),
  role: z.string(),
  rollingAvg30d: z.number(),
  count30d: z.number().int(),
  flagged: z.boolean(),
  flagReason: z.string().nullable(),
  lastComputedAt: z.string().nullable(),
});
export type RatingAggregateView = z.infer<typeof ratingAggregateView>;

/* ── Contactos de confianza (BR-I06) ── */

/** POST /contacts → body. El listado/altas viven en share-service (passthrough del public-bff). */
export const addContactRequest = z.object({
  phone: z.string().regex(peruPhone, 'Teléfono peruano inválido'),
  name: z.string().min(2).max(80),
  relationship: z.string().min(2).max(40),
  email: z.string().email().optional(),
});
export type AddContactRequest = z.infer<typeof addContactRequest>;

/** POST /contacts/:id/verify-otp → body. */
export const verifyContactOtpRequest = z.object({ code: z.string().length(6) });
export type VerifyContactOtpRequest = z.infer<typeof verifyContactOtpRequest>;

/** GET /contacts → ítem del listado (gRPC GetTrustedContacts). */
export const contactView = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string(),
  relationship: z.string(),
  verified: z.boolean(),
});
export type ContactView = z.infer<typeof contactView>;

/** Recurso de contacto devuelto por share-service en los comandos REST. */
export const contactResource = z.object({
  id: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  name: z.string(),
  relationship: z.string(),
  verified: z.boolean(),
  createdAt: z.string(),
});
export type ContactResource = z.infer<typeof contactResource>;

/** POST /contacts → respuesta: contacto creado + OTP enviado. */
export const addContactResult = z.object({
  contact: contactResource,
  otpSent: z.literal(true),
});
export type AddContactResult = z.infer<typeof addContactResult>;

/** POST /contacts/:id/resend-otp → respuesta. */
export const resendContactOtpResult = z.object({ otpSent: z.literal(true) });
export type ResendContactOtpResult = z.infer<typeof resendContactOtpResult>;

/* ── Borrado de cuenta (derecho al olvido, BR-S06) ── */

/** POST /users/me/deletion → respuesta (202): inicio de la gracia de 30 días. */
export const deletionRequestResult = z.object({ graceUntil: z.string() });
export type DeletionRequestResult = z.infer<typeof deletionRequestResult>;

/* ── Consentimientos (Ley 29733) ── */

/**
 * POST /users/me/consents → body. Aceptación de consentimientos del pasajero (Ley 29733).
 * El registro es APPEND-ONLY: cada envío crea un row inmutable; el estado vigente es el más reciente.
 * La IP de origen la añade el public-bff desde el request (NO se envía desde el cliente).
 */
export const recordConsentRequest = z.object({
  /** Tratamiento de datos personales (base legal del servicio). */
  dataProcessing: z.boolean(),
  /** Cámara en vivo del habitáculo durante el viaje. */
  inCabinCamera: z.boolean(),
  /** Compartir ubicación con contactos de confianza / familia. */
  location: z.boolean(),
  /** Comunicaciones de marketing/promociones (opt-in). */
  marketing: z.boolean(),
  /** Versión de la política de privacidad aceptada (ej. "2026-05-01"). */
  policyVersion: z.string().min(1).max(40),
  /**
   * Clave de idempotencia (UUIDv7) emitida por el cliente. Reenviar la MISMA dedupKey (reintento de
   * red) devuelve el row ya registrado en vez de duplicarlo. Opcional por backward-compat: los
   * clientes viejos que no la envían siguen en modo append-only puro (espeja el dedupKey de panic).
   */
  dedupKey: z.string().uuid().optional(),
});
export type RecordConsentRequest = z.infer<typeof recordConsentRequest>;

/** Consentimiento registrado (append-only). Respuesta de POST (201) y de GET (vigente). */
export const consentRecorded = z.object({
  id: z.string(),
  userId: z.string(),
  dataProcessing: z.boolean(),
  inCabinCamera: z.boolean(),
  location: z.boolean(),
  marketing: z.boolean(),
  policyVersion: z.string(),
  /** Momento de la aceptación (ISO-8601). */
  acceptedAt: z.string(),
});
export type ConsentRecorded = z.infer<typeof consentRecorded>;

/** GET /users/me/consents → consentimiento VIGENTE (el más reciente) o `null` si nunca registró. */
export const currentConsent = consentRecorded.nullable();
export type CurrentConsent = z.infer<typeof currentConsent>;

/* ── Lugares guardados del pasajero (/places · places-service vía public-bff) ── */

/**
 * Tipo de lugar guardado (espeja `PlaceKind` del places-service y el enum del BFF).
 * HOME/WORK son únicos por usuario (el POST hace upsert); FAVORITE admite varios (tope server-side).
 */
export const savedPlaceKind = z.enum(['HOME', 'WORK', 'FAVORITE']);
export type SavedPlaceKind = z.infer<typeof savedPlaceKind>;

/**
 * GET /places (lista) y respuesta de POST/PUT → vista pública de un lugar guardado.
 * Coordenadas PLANAS (`lat`/`lng`, no anidadas) tal como las emite el BFF. `subtitle` es NULLABLE
 * (el BFF normaliza el subtítulo vacío a null). `updatedAt` lo devuelve el BFF aunque la app no lo
 * use (opcional para tolerar respuestas que lo omitan). El `userId` NO viaja: lo scopea el JWT.
 */
export const savedPlace = z.object({
  id: z.string(),
  kind: savedPlaceKind,
  label: z.string(),
  subtitle: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type SavedPlace = z.infer<typeof savedPlace>;

/** GET /places → lista ordenada server-side (HOME, WORK, luego FAVORITEs por createdAt desc). */
export const savedPlaceList = z.array(savedPlace);
export type SavedPlaceList = z.infer<typeof savedPlaceList>;

/**
 * POST /places → body. Crea un lugar (HOME/WORK hacen upsert; FAVORITE agrega). El `userId` NUNCA
 * viaja en el cuerpo (anti-IDOR): sale del JWT. `subtitle` es opcional (0..120). Coordenadas planas.
 */
export const createSavedPlace = z.object({
  kind: savedPlaceKind,
  label: z.string().min(1).max(40),
  subtitle: z.string().max(120).optional(),
  lat: z.number(),
  lng: z.number(),
});
export type CreateSavedPlace = z.infer<typeof createSavedPlace>;

/** PUT /places/:id → body. Mismos campos que la creación (reemplaza la etiqueta/subtítulo/punto). */
export const updateSavedPlace = createSavedPlace;
export type UpdateSavedPlace = CreateSavedPlace;

/* ═══════════════════════ CONDUCTOR (driver-bff) ═══════════════════════ */

/* ── Turno (shift) ── */

/** POST /drivers/shift/start → body. `sessionRef` = referencia de la sesión biométrica ONNX (BR-I02). */
export const driverStartShiftRequest = z.object({
  sessionRef: z.string(),
  geoLat: z.number().min(-90).max(90).optional(),
  geoLon: z.number().min(-180).max(180).optional(),
});
export type DriverStartShiftRequest = z.infer<typeof driverStartShiftRequest>;

/** POST /drivers/shift/start → respuesta (identity-service): estado + score biométrico. */
export const driverShiftStartResult = z.object({
  status: z.string(),
  score: z.number(),
});
export type DriverShiftStartResult = z.infer<typeof driverShiftStartResult>;

/** POST /drivers/shift/end | /pause → respuesta: nuevo estado. */
export const driverShiftStatusResult = z.object({ status: z.string() });
export type DriverShiftStatusResult = z.infer<typeof driverShiftStatusResult>;

/** GET /drivers/shift/state → estado actual del turno (resuelto vía identity gRPC). */
export const driverShiftStateView = z.object({
  driverId: z.string(),
  status: z.string(),
});
export type DriverShiftStateView = z.infer<typeof driverShiftStateView>;

/* ── Gate biométrico de turno + enrolamiento con liveness (BR-I02) ── */

/**
 * Acción del reto de liveness ACTIVO. Espeja `LivenessAction` de @veo/shared-types: el biometric-service
 * emite uno de estos valores y la app guía al conductor a ejecutarlo. Tiparlo como `z.enum` (no
 * `z.string()`) hace que comparar contra un literal fuera del set rompa el typecheck en la app.
 */
export const livenessAction = z.enum(['TURN_LEFT', 'TURN_RIGHT', 'NOD', 'SMILE']);
export type LivenessAction = z.infer<typeof livenessAction>;

/**
 * Reto de liveness activo (mismo shape para el enroll y el turno). Lo emite:
 *  - GET /drivers/me/biometric/liveness/challenge (enrolamiento del conductor)
 *  - POST /drivers/shift/biometric/challenge (gate de inicio de turno)
 */
export const driverLivenessChallengeResponse = z.object({
  challengeId: z.string(),
  action: livenessAction,
  instructions: z.string(),
  expiresAt: z.string(),
});
export type DriverLivenessChallengeResponse = z.infer<typeof driverLivenessChallengeResponse>;

/**
 * POST /drivers/biometric/enroll → body. Enrolamiento CON LIVENESS: el `challengeId` del reto emitido por
 * GET /drivers/me/biometric/liveness/challenge + los `frames` capturados mientras el conductor ejecutaba la
 * acción (anti-spoofing). Reemplaza la foto suelta `{ photo }` (spoofeable con una imagen).
 */
export const driverBiometricEnrollRequest = z.object({
  challengeId: z.string().min(1),
  frames: z.array(z.string().min(1)).min(1).max(30),
});
export type DriverBiometricEnrollRequest = z.infer<typeof driverBiometricEnrollRequest>;

/** POST /drivers/biometric/enroll → respuesta. */
export const driverBiometricEnrollResult = z.object({
  enrolled: z.literal(true),
  enrolledAt: z.string(),
});
export type DriverBiometricEnrollResult = z.infer<typeof driverBiometricEnrollResult>;

/**
 * Reto de liveness del TURNO (POST /drivers/shift/biometric/challenge). Mismo shape que
 * `driverLivenessChallengeResponse` (alias retro-compatible para los consumidores existentes).
 */
export const biometricChallenge = driverLivenessChallengeResponse;
export type DriverBiometricChallenge = z.infer<typeof biometricChallenge>;

/** POST /drivers/shift/biometric/verify → body. Reto + frames del liveness en base64. */
export const driverBiometricVerifyRequest = z.object({
  challengeId: z.string(),
  frames: z.array(z.string().min(1)).min(1),
});
export type DriverBiometricVerifyRequest = z.infer<typeof driverBiometricVerifyRequest>;

/**
 * POST /drivers/shift/biometric/verify → respuesta: sessionRef de un solo uso + el resultado.
 * El sessionRef se entrega luego a POST /drivers/shift/start para abrir el turno (BR-I02).
 */
export const biometricVerifyResult = z.object({
  sessionRef: z.string(),
  score: z.number(),
  livenessPassed: z.boolean(),
  matchPassed: z.boolean(),
});
export type DriverBiometricVerifyResult = z.infer<typeof biometricVerifyResult>;

/**
 * POST /media/rooms/:tripId/publisher-token → token LiveKit de PUBLICACIÓN de la cámara del
 * conductor durante el viaje (BR-S01). `room` = nombre de la room del viaje.
 */
export const driverPublisherGrant = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  room: z.string().min(1),
});
export type DriverPublisherGrant = z.infer<typeof driverPublisherGrant>;

/* ── Perfil/onboarding del conductor ── */

export const driverOnboardRequest = z.object({
  licenseNumber: z.string(),
  licenseExpiresAt: z.string(),
});
export type DriverOnboardRequest = z.infer<typeof driverOnboardRequest>;

export const driverDocumentView = z.object({
  type: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  ok: z.boolean(),
});
export type DriverDocumentView = z.infer<typeof driverDocumentView>;

/** Estado simple del documento para la app del conductor (derivado del estado de fleet). */
export const driverDocumentSimpleStatus = z.enum([
  'vigente',
  'por_vencer',
  'vencido',
  'en_revision',
  'rechazado',
]);
export type DriverDocumentSimpleStatus = z.infer<typeof driverDocumentSimpleStatus>;

/**
 * GET /drivers/me/documents → documento del conductor con su tipo, número, vencimiento y estado.
 * `status` es el crudo de fleet (VALID/EXPIRING_SOON/EXPIRED/PENDING_REVIEW/REJECTED);
 * `simpleStatus` es el estado en español para la UI. POST /drivers/me/documents devuelve el creado.
 */
/**
 * Cara del documento proyectada al conductor (sub-lote 3A · SIN la key S3 interna). La app la usa para
 * saber qué caras ya subió (p.ej. DNI: FRONT y/o BACK). El binario solo lo firma el admin-bff.
 */
export const driverDocumentImage = z.object({
  side: documentSide,
  order: z.number().int(),
});
export type DriverDocumentImage = z.infer<typeof driverDocumentImage>;

export const driverDocument = z.object({
  type: z.string(),
  documentNumber: z.string(),
  status: z.string(),
  simpleStatus: driverDocumentSimpleStatus,
  expiresAt: z.string().nullable(),
  ok: z.boolean(),
  // M5: motivo del rechazo que escribió el operador; el conductor lo VE para saber qué corregir. null
  // si el documento no está rechazado o el operador no dio motivo (degradación honesta, nunca falso).
  rejectionReason: z.string().nullable(),
  // Sub-lote 3A: las caras del documento (side + order). [] si todavía no se subió ninguna imagen.
  images: z.array(driverDocumentImage),
});
export type DriverDocument = z.infer<typeof driverDocument>;

/** Espeja `FleetDocumentType.VEHICLE_PHOTO` de @veo/shared-types: el único tipo SIN número (es una foto). */
const FLEET_DOC_VEHICLE_PHOTO = 'VEHICLE_PHOTO';

/**
 * Onboarding sin-formularios (Lote 1 · cliente) · DATA EXTRAÍDA por OCR on-device que el cliente ENVÍA al
 * borde. Espeja el contrato `ExtractedDocumentData` de @veo/shared-types (unión discriminada por `type`) y
 * sus cotas EXACTAS del DTO del driver-bff/fleet-service. Se ESPEJA (no se importa shared-types) por la
 * misma convención que `fleetDocumentType`/`FLEET_DOC_VEHICLE_PHOTO`: el contrato móvil declara sus formas
 * con zod para que las apps RN no arrastren shared-types al bundle de Metro. Si el backend cambia las
 * cotas, este espejo debe seguirlo (igual que el DTO espeja shared-types server-side).
 *
 * Cotas (deben coincidir con `extracted-data.dto.ts`): strings de id 1..40, strings de texto 1..120,
 * fechas calendario `YYYY-MM-DD`. TODOS los campos opcionales (el OCR degrada campo a campo). El
 * discriminante `type` usa los valores canónicos de `FleetDocumentType` (mismos strings que el enum).
 */
const OCR_ID_MAX = 40;
const OCR_TEXT_MAX = 120;
/** Fecha calendario ISO `YYYY-MM-DD` (sin hora). Espeja `ISO_DATE_PATTERN` del DTO del backend. */
const ocrIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe tener formato YYYY-MM-DD');
const ocrId = z.string().min(1).max(OCR_ID_MAX);
const ocrText = z.string().min(1).max(OCR_TEXT_MAX);

/** DNI: data extraída del documento de identidad (espeja `ExtractedDniData`). */
export const extractedDniData = z.object({
  type: z.literal('DNI'),
  fullName: ocrText.optional(),
  documentNumber: ocrId.optional(),
  birthdate: ocrIsoDate.optional(),
});
export type ExtractedDniData = z.infer<typeof extractedDniData>;

/** SOAT: data extraída de la póliza (espeja `ExtractedSoatData`). */
export const extractedSoatData = z.object({
  type: z.literal('SOAT'),
  policyNumber: ocrId.optional(),
  expiresAt: ocrIsoDate.optional(),
});
export type ExtractedSoatData = z.infer<typeof extractedSoatData>;

/** Tarjeta de propiedad: paridad con el backend (el cliente NO la PRODUCE hasta el Lote 2). */
export const extractedPropertyCardData = z.object({
  type: z.literal('PROPERTY_CARD'),
  plate: ocrId.optional(),
  make: ocrText.optional(),
  model: ocrText.optional(),
  year: z.number().int().optional(),
  mtcCategory: ocrId.optional(),
});
export type ExtractedPropertyCardData = z.infer<typeof extractedPropertyCardData>;

/** Licencia A1: data extraída de la licencia (espeja `ExtractedLicenseA1Data`). */
export const extractedLicenseA1Data = z.object({
  type: z.literal('LICENSE_A1'),
  documentNumber: ocrId.optional(),
  expiresAt: ocrIsoDate.optional(),
  /** Categoría canónica leída por OCR (`A-I`/`B-IIb`/…): clase + categoría del documento real, combinadas. */
  category: ocrId.optional(),
});
export type ExtractedLicenseA1Data = z.infer<typeof extractedLicenseA1Data>;

/**
 * Data extraída por OCR, UNIÓN DISCRIMINADA por `type` (espeja `ExtractedDocumentData`). Paridad COMPLETA
 * con el backend (las 4 variantes) aunque el cliente hoy solo PRODUCE DNI/SOAT/LICENSE_A1. `forbidNonWhitelisted`
 * del backend rechaza claves extra, así que el cliente debe enviar EXACTO la forma de la variante.
 */
export const extractedDocumentData = z.discriminatedUnion('type', [
  extractedDniData,
  extractedSoatData,
  extractedPropertyCardData,
  extractedLicenseA1Data,
]);
export type ExtractedDocumentData = z.infer<typeof extractedDocumentData>;

/**
 * Motor de OCR que produjo la `extractedData` (espeja el enum CERRADO `OcrEngine` de @veo/shared-types).
 * `@IsIn(OCR_ENGINES)` del backend rechaza cualquier otro valor: este `z.enum` debe coincidir 1:1.
 */
export const ocrEngine = z.enum(['ios-visionkit', 'android-mlkit', 'paddleocr-server']);
export type OcrEngineValue = z.infer<typeof ocrEngine>;

/**
 * POST /drivers/me/documents → body. Registra/actualiza un documento (queda en revisión manual).
 * `documentNumber` es requerido POR TIPO: la foto del vehículo (`VEHICLE_PHOTO`) no tiene número; el
 * resto de los documentos (licencia/SOAT/tarjeta/…) SÍ lo exigen. El `refine` lo valida contextual.
 */
/** Una imagen del documento en el alta (sub-lote 3A): clave S3 ya subida (vía presign) + cara tipada. */
export const addDocumentImage = z.object({
  s3Key: z.string().min(1),
  side: documentSide,
});
export type AddDocumentImage = z.infer<typeof addDocumentImage>;

export const addDocumentRequest = z
  .object({
    type: z.string().min(1),
    documentNumber: z.string().optional(),
    issuedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    // DEPRECADO (sub-lote 3A): clave singular. El camino nuevo es `images` (1..N caras).
    fileS3Key: z.string().optional(),
    // Imágenes del documento (1..N caras). DNI → [FRONT, BACK]; foto de vehículo → N SINGLE; resto → [SINGLE].
    images: z.array(addDocumentImage).min(1).optional(),
    // Onboarding sin-formularios (Lote 1): data extraída por OCR on-device + trazabilidad del motor. El
    // backend valida la forma (unión discriminada acotada) y la persiste como `FleetDocument.extractedData`.
    // Opcional → backward-compatible (registrar SIN OCR sigue OK). El `type` del documento NO tiene por qué
    // coincidir con el `extractedData.type` aquí (el backend revalida); el cliente envía coherente por DI.
    extractedData: extractedDocumentData.optional(),
    /** Motor de OCR que extrajo la data (enum cerrado, anti-spoof). Trazabilidad. */
    ocrEngine: ocrEngine.optional(),
    /** Instante de la extracción OCR (ISO-8601). Espeja la cota del backend (`@IsISO8601()`): valida el formato. */
    ocrAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((d) => d.type === FLEET_DOC_VEHICLE_PHOTO || (d.documentNumber?.length ?? 0) >= 1, {
    message: 'documentNumber requerido para este tipo de documento',
    path: ['documentNumber'],
  });
export type AddDocumentRequest = z.infer<typeof addDocumentRequest>;

/**
 * Content-Types permitidos para subir el binario de un documento (foto JPEG/PNG o PDF). Allowlist
 * ÚNICA del contrato (Ley 29733: el binario es PII). Debe coincidir con la del driver-bff/media: el
 * `contentType` viaja firmado en la URL prefirmada y el cliente lo reenvía exacto en el PUT.
 */
export const documentUploadContentType = z.enum(['image/jpeg', 'image/png', 'application/pdf']);
export type DocumentUploadContentType = z.infer<typeof documentUploadContentType>;

/**
 * POST /drivers/me/documents/presign → body (sub-lote 3A · N imágenes). La app pide N tickets (uno POR
 * CARA) para subir los binarios de un documento. `type` es el tipo (LICENSE_A1 | SOAT | ...);
 * `contentType` el del archivo; `sides` las caras (FRONT|BACK|SINGLE). El driver-bff resuelve el driverId.
 *
 * Backward-compat: `sides` es OPCIONAL. Omitido → [SINGLE] (1 imagen, comportamiento histórico). DNI →
 * [FRONT, BACK]; foto de vehículo → N [SINGLE, ...].
 */
export const documentUploadTicketRequest = z.object({
  type: z.string().min(1),
  contentType: documentUploadContentType,
  sides: z.array(documentSide).min(1).optional(),
});
export type DocumentUploadTicketRequest = z.infer<typeof documentUploadTicketRequest>;

/** Un ticket de subida por CARA (sub-lote 3A): la cara + la URL PUT prefirmada + la key S3 + headers. */
export const documentUploadSideTicket = z.object({
  side: documentSide,
  uploadUrl: z.string(),
  fileS3Key: z.string(),
  requiredHeaders: z.record(z.string(), z.string()),
});
export type DocumentUploadSideTicket = z.infer<typeof documentUploadSideTicket>;

/**
 * POST /drivers/me/documents/presign → respuesta (sub-lote 3A · N imágenes). Ticket(s) de subida directa
 * al storage soberano (el binario NO pasa por la API):
 *  - `tickets`: uno POR CARA (side + uploadUrl + fileS3Key + requiredHeaders). Para 1 imagen, un solo SINGLE.
 *  - `expiresAt`: vencimiento común de los tickets (ISO-8601).
 * La app sube cada binario con un PUT a su `uploadUrl`, luego llama POST /drivers/me/documents con
 * `images: [{ s3Key, side }]` (una por cara).
 */
export const documentUploadTicket = z.object({
  tickets: z.array(documentUploadSideTicket).min(1),
  expiresAt: z.string(),
});
export type DocumentUploadTicket = z.infer<typeof documentUploadTicket>;

/** GET /drivers/me → perfil agregado (identity + rating + fleet). */
export const driverProfileView = z.object({
  driverId: z.string(),
  userId: z.string(),
  phone: z.string(),
  kycStatus: z.string(),
  currentStatus: z.string(),
  backgroundCheckStatus: z.string(),
  /**
   * Motivo del último rechazo de antecedentes; `null` si NO está rechazado o no se dio motivo. La app
   * lo muestra en la pantalla de RECHAZO (corregir-y-reenviar). El driver-bff lo resuelve por gRPC
   * (DriverReply.rejectionReason, "" → null).
   */
  rejectionReason: z.string().nullable(),
  averageRating: z.number(),
  rating: z
    .object({
      rollingAvg30d: z.number(),
      count30d: z.number().int(),
      flagged: z.boolean(),
      flagReason: z.string().nullable(),
    })
    .nullable(),
  documents: z.array(driverDocumentView),
  /**
   * Cumplimiento documental del CONDUCTOR (solo los docs del alta: licencia, SOAT, tarjeta). Modela el
   * ciclo de vida real de cada tipo requerido y NO lo confunde con antecedentes/KYC (ejes aparte):
   *  - `missing`: tipos SIN ningún documento subido (presencia → wizard).
   *  - `rejected`: tipos cuyo documento fue rechazado (corregir-y-reenviar).
   *  - `submittedAllRequired`: ya subió TODOS los requeridos (a revisión o aprobados).
   *  - `biometricEnrolled`: enroló su biometría facial (diferenciador no negociable VEO).
   *  - `allApproved`/`compliant`: TODOS los requeridos aprobados (VALID/EXPIRING_SOON).
   *
   * CONDICIÓN DE `in_review` (server-truth): el conductor está LISTO PARA REVISIÓN cuando
   * `submittedAllRequired && biometricEnrolled`. La biometría es un eje SEPARADO de los documentos a
   * propósito (no se mezcla dentro de `submittedAllRequired`). El gate FUERTE curl-proof vive en la
   * APROBACIÓN del operador (identity rechaza con 409 si falta el embedding); estos flags son el reflejo.
   */
  compliance: z.object({
    /** TODOS los requeridos aprobados (alias de `allApproved`; mantiene compat con ProfileScreen). */
    compliant: z.boolean(),
    /** Tipos requeridos (los que el conductor sube en el alta). */
    requiredTypes: z.array(z.string()),
    /** Tipos requeridos SIN ningún documento subido (genuinamente faltantes). */
    missing: z.array(z.string()),
    /** Tipos requeridos cuyo documento fue RECHAZADO por el operador. */
    rejected: z.array(z.string()),
    /** true si el conductor ya subió TODOS los requeridos (a cualquier estado). */
    submittedAllRequired: z.boolean(),
    /** true si TODOS los requeridos están aprobados (VALID/EXPIRING_SOON). */
    allApproved: z.boolean(),
    /**
     * true si el conductor enroló su biometría facial de referencia (diferenciador no negociable VEO).
     * Eje SEPARADO de los documentos: in_review requiere (submittedAllRequired && biometricEnrolled).
     */
    biometricEnrolled: z.boolean(),
  }),
});
export type DriverProfileView = z.infer<typeof driverProfileView>;

/**
 * POST /drivers/me/resubmit → respuesta. El conductor RECHAZADO corrigió sus datos y reenvió a revisión
 * (REJECTED → PENDING). Devuelve el estado de antecedentes resultante (PENDING). El driver-bff lo proxya
 * a identity-service (REST interno firmado).
 */
export const driverResubmitResult = z.object({
  id: z.string(),
  backgroundCheckStatus: z.string(),
});
export type DriverResubmitResult = z.infer<typeof driverResubmitResult>;

/* ── Datos personales del conductor (PII · PATCH /drivers/me/personal) ── */

/** DNI peruano: exactamente 8 dígitos. */
const dniPattern = /^\d{8}$/;
/** Fecha de nacimiento en formato calendario yyyy-mm-dd (sin hora). */
const birthDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PATCH /drivers/me/personal → body. Datos personales del conductor (PII). El driver-bff lo proxya
 * a identity-service por REST interno firmado (la PII NUNCA viaja por gRPC).
 */
export const driverPersonalDataRequest = z.object({
  legalName: z.string().min(1).max(120),
  dni: z.string().regex(dniPattern, 'El DNI debe tener exactamente 8 dígitos'),
  birthDate: z.string().regex(birthDatePattern, 'birthDate debe tener formato yyyy-mm-dd'),
});
export type DriverPersonalDataRequest = z.infer<typeof driverPersonalDataRequest>;

/**
 * PATCH /drivers/me/personal → respuesta: la VISTA de datos personales que devuelve identity. Los
 * campos son `.nullable()` porque las columnas en identity son nullables: la vista los lee tal cual y
 * puede devolver null si el conductor aún no completó algún dato (alineado con identity-view ↔ bff-dto).
 */
export const driverPersonalData = z.object({
  legalName: z.string().nullable(),
  dni: z.string().nullable(),
  birthDate: z.string().nullable(),
});
export type DriverPersonalData = z.infer<typeof driverPersonalData>;

/* ── Vehículo del conductor (onboarding self-service · /drivers/vehicles) ── */

/**
 * POST /drivers/vehicles → body. Alta self-service del vehículo del conductor. El driver-bff lo
 * proxya a fleet (REST interno firmado); fleet resuelve el driverId desde la identidad propagada.
 * El vehículo queda pendiente de verificación (status=PENDING_REVIEW).
 */
export const registerVehicleRequest = z
  .object({
    vehicleType: mobileVehicleType,
    /** Placa peruana XXX-XXX (guion opcional). fleet la normaliza y revalida. */
    plate: z.string().min(1),
    /**
     * B5-2: id del modelo del catálogo (VehicleModelSpec APPROVED) elegido en el onboarding. Si viene,
     * fleet snapshotea make/model/vehicleType del spec e ignora el texto libre.
     */
    modelSpecId: z.string().uuid().optional(),
    /** Marca a texto libre. Requerida solo si NO se eligió un modelo del catálogo. */
    make: z.string().min(1).max(60).optional(),
    /** Modelo a texto libre. Requerido solo si NO se eligió un modelo del catálogo. */
    model: z.string().min(1).max(60).optional(),
    /** Año del vehículo (>= 2005). BR-D04 (>= 2017) lo aplica fleet-service. */
    year: z
      .number()
      .int()
      .min(2005)
      .max(new Date().getUTCFullYear() + 1),
    color: z.string().min(1).max(30).optional(),
    /**
     * LOTE 1 · categoría MTC CRUDA leída de la tarjeta de propiedad (`M1`, `L3`, `N1`…). Es la FUENTE DE
     * VERDAD del tipo: fleet DERIVA `vehicleType` de acá (M1→CAR, L*→MOTO; resto→hint del body). Ausente en
     * la carga manual del tipo (sin tarjeta leída). Cap de 16 chars ALINEADO con el DTO de fleet
     * (`RegisterDriverVehicleDto.mtcCategory` @Length(1,16)): un OCR ruidoso más largo se corta en el wire
     * con un error de campo accionable, en vez de pasar y reventar con un 400 sin campo aguas abajo.
     */
    mtcCategory: z.string().min(1).max(16).optional(),
  })
  .refine((v) => Boolean(v.modelSpecId) || (Boolean(v.make) && Boolean(v.model)), {
    message: 'Elegí un modelo del catálogo (modelSpecId) o indicá marca y modelo',
    path: ['modelSpecId'],
  });
export type RegisterVehicleRequest = z.infer<typeof registerVehicleRequest>;

/* ── Catálogo de modelos para el selector del onboarding (GET /drivers/vehicle-models · B5-2) ── */

/**
 * Modelo del catálogo curado que el conductor puede ELEGIR. La app lo muestra (marca/modelo/rango de
 * años/asientos) y manda su `id` como `modelSpecId` al registrar. No incluye campos de revisión.
 */
export const driverVehicleModelView = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  yearFrom: z.number().int(),
  yearTo: z.number().int(),
  vehicleType: mobileVehicleType,
  seats: z.number().int(),
});
export type DriverVehicleModelView = z.infer<typeof driverVehicleModelView>;

/** GET /drivers/vehicle-models → catálogo de modelos aprobados (filtrable por vehicleType y q). */
export const driverVehicleModelList = z.array(driverVehicleModelView);
export type DriverVehicleModelList = z.infer<typeof driverVehicleModelList>;

/**
 * POST /drivers/vehicle-models → body. El conductor SOLICITA un modelo que no está en el catálogo (B5-2.c).
 * Trae solo lo que conoce; el operador completa la ficha técnica al aprobar. Queda PENDING_REVIEW.
 */
export const requestVehicleModelRequest = z.object({
  make: z.string().min(1).max(60),
  model: z.string().min(1).max(60),
  yearFrom: z
    .number()
    .int()
    .min(1990)
    .max(new Date().getUTCFullYear() + 1),
  yearTo: z
    .number()
    .int()
    .min(1990)
    .max(new Date().getUTCFullYear() + 1),
  vehicleType: mobileVehicleType,
  seats: z.number().int().min(1).max(20),
});
export type RequestVehicleModelRequest = z.infer<typeof requestVehicleModelRequest>;

/** Respuesta del alta de solicitud: lo mínimo para confirmarle al conductor que quedó en revisión. */
export const driverModelRequestView = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  status: z.string(),
});
export type DriverModelRequestView = z.infer<typeof driverModelRequestView>;

/**
 * Vehículo del conductor (POST /drivers/vehicles y GET /drivers/vehicles).
 * `status` = estado de revisión del onboarding (PENDING_REVIEW|ACTIVE); `docStatus` = estado
 * documental agregado del vehículo (gestionado por el cron de vencimientos de fleet).
 */
export const driverVehicleView = z.object({
  id: z.string(),
  plate: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  vehicleType: mobileVehicleType,
  status: z.string(),
  docStatus: z.string(),
});
export type DriverVehicleView = z.infer<typeof driverVehicleView>;

/** GET /drivers/vehicles → lista de vehículos del conductor (más recientes primero). */
export const driverVehicleList = z.array(driverVehicleView);
export type DriverVehicleList = z.infer<typeof driverVehicleList>;

/* ── Dispatch / oferta entrante (incoming trip) ── */

/** GET /dispatch/surge?lat&lon (lado conductor; zoneId puede ser null). */
export const driverSurgeView = z.object({
  multiplier: z.number(),
  zoneId: z.string().nullable(),
  active: z.boolean(),
});
export type DriverSurgeView = z.infer<typeof driverSurgeView>;

/** GET /dispatch/offers/:matchId → oferta/match (se acepta/rechaza por REST y llega por WS). */
export const driverOfferView = z.object({
  id: z.string(),
  tripId: z.string(),
  driverId: z.string(),
  score: z.number(),
  attempt: z.number().int(),
  surgeMultiplier: z.number(),
  outcome: z.string(),
  offeredAt: z.string().nullable(),
  respondedAt: z.string().nullable(),
});
export type DriverOfferView = z.infer<typeof driverOfferView>;

/* ── PUJA · lado conductor (ADR 010 §6) ──
 * Marketplace "proponé tu precio" visto desde el conductor: ve las pujas OPEN cercanas que PUEDE ofertar y
 * responde aceptando el precio o contraofertando. El `driverId` NUNCA viaja del cliente: lo deriva el
 * driver-bff de la identidad autenticada (anti-IDOR). El gate de elegibilidad se enforce downstream.
 */

/**
 * GET /bids → una puja OPEN cercana que el conductor elegible puede ofertar. `expiresAt` = epoch(ms) del
 * vencimiento de la ventana (para el countdown). Espeja `OpenBidView` del driver-bff y el enrich de
 * `dispatch.offered`.
 */
export const openBidView = z.object({
  tripId: z.string(),
  bidCents: z.number().int(),
  vehicleType: z.string(),
  expiresAt: z.number(),
  originLat: z.number(),
  originLon: z.number(),
  /** BE-2 · solicitudes especiales del pasajero (mascota/equipaje/silla). */
  specialRequests: z.array(z.string()),
});
export type OpenBidView = z.infer<typeof openBidView>;

/**
 * POST /bids/:tripId/offer → body. `ACCEPT_PRICE` debe IGUALAR el bid; `COUNTER` debe ser mayor al bid (y
 * ≤ techo). Las reglas de precio las valida dispatch downstream; la UI clampa para no mandar inválidos.
 */
export const submitOfferRequest = z.object({
  kind: z.enum(['ACCEPT_PRICE', 'COUNTER']),
  priceCents: z.number().int().positive(),
});
export type SubmitOfferRequest = z.infer<typeof submitOfferRequest>;

/** POST /bids/:tripId/offer → respuesta: la oferta que el conductor acaba de enviar (estado PENDING). */
export const submittedOfferView = z.object({
  tripId: z.string(),
  driverId: z.string(),
  kind: z.string(),
  priceCents: z.number().int(),
  etaSeconds: z.number().int(),
  status: z.string(),
});
export type SubmittedOfferView = z.infer<typeof submittedOfferView>;

/* ── Viaje activo (lado conductor) ── */

/** GET /trips/:id → viaje (lado conductor). `status` crudo del downstream. */
export const driverTripView = z.object({
  id: z.string(),
  passengerId: z.string(),
  driverId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  status: z.string(),
  fareCents: z.number().int(),
  currency: z.string(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  paymentMethod: z.string(),
  childMode: z.boolean(),
  penaltyCents: z.number().int(),
});
export type DriverTripView = z.infer<typeof driverTripView>;

/** GET /trips/:id/state → estado del viaje (lado conductor). */
export const driverTripStateView = z.object({ id: z.string(), status: z.string() });
export type DriverTripStateView = z.infer<typeof driverTripStateView>;

/** POST /trips/:id/accept → body. */
export const acceptTripRequest = z.object({ etaSeconds: z.number().int().min(0).optional() });
export type AcceptTripRequest = z.infer<typeof acceptTripRequest>;

/** POST /trips/:id/arriving → body. */
export const arrivingTripRequest = z.object({ etaSeconds: z.number().int().min(0).optional() });
export type ArrivingTripRequest = z.infer<typeof arrivingTripRequest>;

/** POST /trips/:id/start → body (código modo niño si aplica). */
export const startTripRequest = z.object({
  childCode: z
    .string()
    .regex(/^\d{4,6}$/)
    .optional(),
});
export type StartTripRequest = z.infer<typeof startTripRequest>;

/**
 * POST /trips/:id/complete → body. EFECTIVO (decisión del dueño, BR-P03): al terminar el viaje el
 * conductor marca si COBRÓ el efectivo en mano (`cashCollected`) — su lado de la confirmación
 * bilateral (driverConfirmed). Solo aplica a viajes CASH; en digital el BFF lo ignora.
 */
export const completeTripRequest = z.object({ cashCollected: z.boolean().optional() });
export type CompleteTripRequest = z.infer<typeof completeTripRequest>;

/** POST /trips/:id/cancel → body (el actor se fija a DRIVER en el BFF). */
export const driverCancelTripRequest = z.object({ reason: z.string().optional() });
export type DriverCancelTripRequest = z.infer<typeof driverCancelTripRequest>;

/** GET /payments/:id → vista de pago (lado conductor; externalRef puede ser null). */
export const driverPaymentView = z.object({
  id: z.string(),
  tripId: z.string(),
  method: z.string(),
  status: z.string(),
  amountCents: z.number().int(),
  grossCents: z.number().int(),
  /** Propina acumulada del viaje (100% al conductor, fuera de comisión). */
  tipCents: z.number().int(),
  commissionCents: z.number().int(),
  feeCents: z.number().int(),
  externalRef: z.string().nullable(),
});
export type DriverPaymentView = z.infer<typeof driverPaymentView>;

/* ── Navegación turn-by-turn (Ola 2C · OSRM soberano) ── */

/** Maniobra normalizada de un paso de navegación (espeja `RouteManeuver` de @veo/maps). */
export const routeManeuver = z.enum([
  'depart',
  'turn-left',
  'turn-right',
  'turn-slight-left',
  'turn-slight-right',
  'turn-sharp-left',
  'turn-sharp-right',
  'uturn',
  'straight',
  'merge',
  'roundabout',
  'fork',
  'arrive',
]);
export type RouteManeuver = z.infer<typeof routeManeuver>;

/**
 * Un paso/maniobra de la navegación turn-by-turn (Ola 2C). `geometryPolyline` es la polyline
 * codificada (precision 5) de ESE tramo, lista para pintar/animar en MapLibre.
 */
export const routeStep = z.object({
  instruction: z.string(),
  distanceMeters: z.number().int(),
  maneuver: routeManeuver,
  geometryPolyline: z.string(),
});
export type RouteStep = z.infer<typeof routeStep>;

/**
 * GET /trips/:id/route (driver-bff, JWT conductor) → ruta del viaje activo CON pasos de navegación.
 * La ruta cubre el recorrido relevante del conductor: si aún no recogió al pasajero, conductor→
 * recojo→destino (con waypoints intermedios); si ya inició, recojo/posición→destino. `polyline` es la
 * geometría completa; `steps` la lista ordenada de maniobras turn-by-turn.
 */
export const tripRoute = z.object({
  polyline: z.string(),
  distanceMeters: z.number().int(),
  durationSeconds: z.number().int(),
  steps: z.array(routeStep),
  /** Recojo (origen), destino y paradas intermedias ORDENADAS (Ola 2B) para pintar los markers del mapa. */
  origin: geoPoint,
  destination: geoPoint,
  waypoints: z.array(geoPoint),
});
export type TripRoute = z.infer<typeof tripRoute>;

/* ── Mapa de calor de demanda (Ola 2C · H3, dispatch-service) ── */

/**
 * Celda del mapa de calor de demanda (Ola 2C). `h3` es el índice de la celda (res 9);
 * `centroidLat/Lng` su centro; `intensity` la intensidad normalizada 0..1 (1 = la celda más caliente
 * del entorno consultado). La app pinta cada celda con opacidad/color según `intensity`.
 */
export const heatmapCell = z.object({
  h3: z.string(),
  centroidLat: z.number(),
  centroidLng: z.number(),
  intensity: z.number().min(0).max(1),
});
export type HeatmapCell = z.infer<typeof heatmapCell>;

/**
 * GET /heatmap?lat&lng&radius (driver-bff, JWT conductor) → celdas de demanda reciente cerca del
 * conductor, ordenadas por intensidad descendente. `[]` si no hay demanda en el entorno.
 */
export const heatmapView = z.object({
  cells: z.array(heatmapCell),
  /** Instante del snapshot (ISO-8601). */
  generatedAt: z.string(),
});
export type HeatmapView = z.infer<typeof heatmapView>;

/* ── Incentivos al conductor (Ola 2C · payment-service) ── */

/** Tipo de incentivo del conductor (Ola 2C). */
export const incentiveType = z.enum(['META_VIAJES', 'HORA_PICO']);
export type IncentiveType = z.infer<typeof incentiveType>;

/**
 * GET /incentives (driver-bff, JWT conductor) → un incentivo activo del conductor con su progreso.
 *  - META_VIAJES: completa `targetTrips` viajes en la ventana → bono `rewardCents`.
 *  - HORA_PICO: multiplicador de ganancias en una franja; `multiplierBps` (puntos básicos, p.ej.
 *    12000 = +20% sobre 1.0). En HORA_PICO `targetTrips` puede ser 0 y `rewardCents` 0.
 */
export const driverIncentive = z.object({
  id: z.string(),
  type: incentiveType,
  title: z.string(),
  description: z.string(),
  /** Viajes objetivo (META_VIAJES). 0 si no aplica. */
  targetTrips: z.number().int(),
  /** Viajes ya contabilizados del conductor en la ventana del incentivo. */
  progressTrips: z.number().int(),
  /** Bono en céntimos PEN al completar (META_VIAJES). 0 si no aplica. */
  rewardCents: z.number().int(),
  /** Multiplicador de ganancias en puntos básicos de %·100 (HORA_PICO). 0 si no aplica. */
  multiplierBps: z.number().int(),
  /** Vencimiento del incentivo (ISO-8601). */
  expiresAt: z.string(),
  /** Si el conductor ya cumplió la meta (META_VIAJES) o la franja está activa (HORA_PICO). */
  completed: z.boolean(),
});
export type DriverIncentive = z.infer<typeof driverIncentive>;

/** GET /incentives → lista de incentivos activos del conductor con progreso. */
export const driverIncentiveList = z.array(driverIncentive);
export type DriverIncentiveList = z.infer<typeof driverIncentiveList>;

/* ── Ganancias / payouts ── */
// El enum `payoutStatus` vive en types.ts (contrato compartido mobile + admin): UNA sola fuente del
// vocabulario de payout en el package, sin riesgo de drift entre dos definiciones.

/** Liquidación (payout) del conductor (espeja el modelo Payout de payment-service). */
export const driverPayoutView = z.object({
  id: z.string(),
  driverId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: payoutStatus,
  processedAt: z.string().nullable(),
  heldReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriverPayoutView = z.infer<typeof driverPayoutView>;

/**
 * GET /earnings/summary → resumen de ganancias del conductor autenticado, agregado a partir de
 * SUS payouts reales (sin mocks). Montos en céntimos PEN.
 */
export const earningsSummary = z.object({
  driverId: z.string(),
  currency: z.string(),
  payoutCount: z.number().int(),
  totalGrossCents: z.number().int(),
  totalCommissionCents: z.number().int(),
  totalNetCents: z.number().int(),
  paidNetCents: z.number().int(),
  pendingNetCents: z.number().int(),
  payouts: z.array(driverPayoutView),
});
export type EarningsSummary = z.infer<typeof earningsSummary>;

/** GET /payouts → lista de payouts del conductor autenticado. */
export const driverPayoutList = z.array(driverPayoutView);
export type DriverPayoutList = z.infer<typeof driverPayoutList>;

/** Desglose de ganancias de una ventana (hoy/semana). Montos en céntimos PEN. */
export const driverEarningsBreakdown = z.object({
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  /** Propinas del período (100% al conductor, fuera de comisión). */
  tipCents: z.number().int(),
  netCents: z.number().int(),
  tripCount: z.number().int(),
});
export type DriverEarningsBreakdown = z.infer<typeof driverEarningsBreakdown>;

/**
 * GET /earnings/breakdown → desglose de ganancias HOY y de la SEMANA del conductor autenticado,
 * agregado sobre cobros CAPTURED reales de payment-service (sin mocks). Incluye las propinas.
 */
export const driverEarningsSummary = z.object({
  driverId: z.string(),
  currency: z.string(),
  today: driverEarningsBreakdown,
  week: driverEarningsBreakdown,
});
export type DriverEarningsSummary = z.infer<typeof driverEarningsSummary>;

/* ═══════════════════════ CHAT IN-APP (conductor↔pasajero) ═══════════════════════ */

/** Rol del emisor de un mensaje de chat. */
export const chatSenderRole = z.enum(['PASSENGER', 'DRIVER']);
export type ChatSenderRole = z.infer<typeof chatSenderRole>;

/**
 * Mensaje de chat de un viaje (Ola 2A). Lo devuelven:
 *  - Pasajero: GET/POST `/trips/:id/messages` (public-bff).
 *  - Conductor: GET/POST `/trips/:id/messages` (driver-bff).
 * Y llega en tiempo real por el evento socket `chat:message` (ver namespaces más abajo).
 */
export const chatMessage = z.object({
  id: z.string(),
  tripId: z.string(),
  senderId: z.string(),
  senderRole: chatSenderRole,
  body: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

/** GET /trips/:id/messages → historial (orden cronológico ascendente). */
export const chatMessageList = z.array(chatMessage);
export type ChatMessageList = z.infer<typeof chatMessageList>;

/**
 * POST /trips/:id/messages → body. Solo `body`: el BFF fija `senderId`/`senderRole` desde la
 * identidad autenticada y valida que el usuario pertenece al viaje y que el viaje está activo.
 */
export const sendMessageRequest = z.object({
  body: z.string().min(1).max(2000),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequest>;

/* ═══════════════════════ CENTRO DE AYUDA / SOPORTE (ambas apps) ═══════════════════════ */

/**
 * Categoría de un ticket de soporte (Ola 2C). Estable para el filtrado/enrutamiento del backstage.
 * La FAQ es estática del lado app; estas categorías agrupan los tickets que SÍ llegan al backend.
 */
export const supportCategory = z.enum(['TRIP', 'PAYMENT', 'ACCOUNT', 'SAFETY', 'DRIVER', 'OTHER']);
export type SupportCategory = z.infer<typeof supportCategory>;

/** Rol del autor del ticket (lo fija el BFF desde la identidad; no lo envía la app). */
export const supportRole = z.enum(['PASSENGER', 'DRIVER']);
export type SupportRole = z.infer<typeof supportRole>;

/** Estado del ciclo de vida de un ticket. */
export const supportStatus = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']);
export type SupportStatus = z.infer<typeof supportStatus>;

/**
 * POST /support/tickets → body (pasajero: public-bff · conductor: driver-bff). El BFF fija
 * `userId`/`role` desde la identidad autenticada; la app solo manda categoría, asunto, cuerpo y
 * opcionalmente el `tripId` relacionado.
 */
export const createTicketRequest = z.object({
  category: supportCategory,
  subject: z.string().min(3).max(160),
  body: z.string().min(1).max(4000),
  tripId: z.string().uuid().optional(),
});
export type CreateTicketRequest = z.infer<typeof createTicketRequest>;

/**
 * Ticket de soporte (Ola 2C). Lo devuelven POST /support/tickets (creado) y GET /support/tickets
 * (los míos, más recientes primero).
 */
export const supportTicket = z.object({
  id: z.string(),
  userId: z.string(),
  role: supportRole,
  category: supportCategory,
  subject: z.string(),
  body: z.string(),
  status: supportStatus,
  tripId: z.string().nullable(),
  createdAt: z.string(),
});
export type SupportTicket = z.infer<typeof supportTicket>;

/** GET /support/tickets → lista de tickets del usuario autenticado. */
export const supportTicketList = z.array(supportTicket);
export type SupportTicketList = z.infer<typeof supportTicketList>;

/* ═══════════════════════ SOCKET.IO MÓVIL ═══════════════════════ */

/** ETA del conductor hacia el siguiente hito (recojo o destino), en segundos. */
export interface EtaMsg {
  tripId: string;
  etaSeconds: number | null;
  at: string;
}

/** Fin del viaje (completado o cancelado). */
export interface TripEndedMsg {
  tripId: string;
  status: TripStatus;
  at: string;
}

/**
 * Oferta de un conductor sobre la puja del pasajero (ADR 010 §4 · `dispatch.offer_made`). El
 * public-bff la reenvía en vivo a la sala del viaje para que el pasajero vea "N conductores
 * respondieron". `kind` = ACCEPT_PRICE (aceptó el bid) | COUNTER (contraoferta > bid).
 */
export interface OfferMadeMsg {
  tripId: string;
  driverId: string;
  kind: 'ACCEPT_PRICE' | 'COUNTER';
  priceCents: number;
  etaSeconds: number;
  at: string;
}

/**
 * BE-3 · una oferta del board dejó de ser válida con el board AÚN abierto (el conductor dejó de ser
 * elegible). El public-bff la reenvía (`dispatch.offer_withdrawn`) para que la app QUITE esa card al
 * instante (sin esperar el refetch). La app la remueve por `driverId`; el board sigue abierto para elegir otra.
 */
export interface OfferWithdrawnMsg {
  tripId: string;
  driverId: string;
  at: string;
}

/* ── Namespace /passenger (public-bff, Bearer JWT type=passenger) ── */

export interface PassengerServerToClient {
  'trip:update': (msg: TripUpdateMsg) => void;
  'driver:location': (msg: DriverLocationMsg) => void;
  eta: (msg: EtaMsg) => void;
  'trip:ended': (msg: TripEndedMsg) => void;
  /**
   * Mensaje de chat entrante del conductor (Ola 2A). El public-bff lo emite a la sala del viaje
   * tras persistirlo. La app también lo recibe como respuesta del POST /trips/:id/messages.
   */
  'chat:message': (msg: ChatMessage) => void;
  /**
   * Una oferta entró a la puja del pasajero (ADR 010). El public-bff la emite a la sala del viaje
   * al consumir `dispatch.offer_made`. La app la acumula para mostrar las ofertas recibidas en vivo.
   */
  'offer:made': (msg: OfferMadeMsg) => void;
  /**
   * BE-3 · una oferta dejó de ser válida (conductor no elegible) con el board abierto. La app QUITA esa
   * card por `driverId`. El public-bff la emite al consumir `dispatch.offer_withdrawn`.
   */
  'offer:withdrawn': (msg: OfferWithdrawnMsg) => void;
  /**
   * Desenlace de una PARADA propuesta (Lote C4): el conductor aceptó/rechazó o la propuesta venció.
   * El public-bff lo emite al consumir `trip.waypoint_accepted/rejected/expired`. La app cierra el
   * estado "esperando"; en ACCEPTED refetchea el detalle para traer ruta+tarifa nuevas.
   */
  'waypoint:outcome': (msg: WaypointProposalOutcome) => void;
  error: (msg: { code: string; message: string }) => void;
}

export interface PassengerClientToServer {
  /** Pide al servidor re-emitir el último snapshot conocido (estado + ubicación) del viaje. */
  resync: () => void;
}

/**
 * Handshake del namespace /passenger: el access token (Bearer) y el id del viaje activo del pasajero.
 * El gateway verifica el JWT (type=passenger) y que el viaje sea de ESE pasajero y esté activo.
 */
export interface PassengerHandshakeAuth {
  token: string;
  tripId: string;
}

export const PASSENGER_NAMESPACE = '/passenger';

/* ── Namespace /driver (driver-bff, Bearer JWT type=driver) ── */

/** Reporte de GPS que el conductor envía por el evento `location` (sustituye a MQTT, soberanía). */
export const driverLocationReport = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullable().optional(),
  speed: z.number().min(0).nullable().optional(),
  accuracy: z.number().min(0).nullable().optional(),
  ts: z.string(),
  /**
   * Tipo de vehículo activo del conductor en este turno (Ola 2B · tier moto-taxi). Lo envía la app
   * del conductor según el vehículo con el que está operando; dispatch lo usa para ofrecer viajes
   * MOTO solo a motos. Opcional ⇒ el BFF asume CAR (compat con la app actual).
   */
  vehicleType: mobileVehicleType.optional(),
});
export type DriverLocationReport = z.infer<typeof driverLocationReport>;

/** Ack del servidor al recibir un `location`. */
export interface DriverLocationAck {
  ok: boolean;
  error?: string;
}

/** Sobre que el servidor /driver emite con cada evento de dominio reenviado desde Kafka. */
export interface DriverEventEnvelope<T> {
  eventType: string;
  occurredAt: string;
  payload: T;
}

/**
 * Oferta directa (dispatch.offered): el conductor debe aceptar/rechazar antes de `expiresAt`.
 * Enriquecido SOLO en el broadcast de PUJA (ADR 010 §6): la PRESENCIA de `bidCents` distingue una puja
 * abierta (contraofertable) de una oferta FIXED (la actual, a aceptar/rechazar). El matcher FIXED emite sin
 * estos campos. Mismos nombres que `OpenBidView` (GET /bids) — el conductor puede pintar la tarjeta sin
 * refetch, y si quiere el detalle/lista completa cae a `GET /bids`.
 */
export interface DispatchOfferedPayload {
  tripId: string;
  driverId: string;
  matchId: string;
  expiresAt: string;
  bidCents?: number;
  vehicleType?: string;
  originLat?: number;
  originLon?: number;
  specialRequests?: string[];
}

/** Match encontrado (dispatch.match_found). */
export interface DispatchMatchPayload {
  tripId: string;
  driverId: string;
  vehicleId?: string;
  scoreMs: number;
}

/**
 * Propina añadida a un viaje ya cobrado (payment.tip_added). El 100% es del conductor. El driver-bff
 * la reenvía en vivo para celebrarla en la app; el monto en céntimos (entero positivo).
 */
export interface TipAddedPayload {
  paymentId: string;
  tripId: string;
  driverId?: string;
  tipCents: number;
}

export interface DriverServerToClient {
  'dispatch:offer': (msg: DriverEventEnvelope<DispatchOfferedPayload>) => void;
  'dispatch:match': (msg: DriverEventEnvelope<DispatchMatchPayload>) => void;
  'trip:update': (msg: DriverEventEnvelope<unknown>) => void;
  /**
   * Mensaje de chat entrante del pasajero (Ola 2A). El driver-bff lo emite a la sala del viaje
   * tras persistirlo. La app también lo recibe como respuesta del POST /trips/:id/messages.
   */
  'chat:message': (msg: ChatMessage) => void;
  /** Propina recibida en vivo (payment.tip_added → driver-bff). El conductor la ve al instante. */
  'payment:tip': (msg: DriverEventEnvelope<TipAddedPayload>) => void;
  /**
   * El pasajero PROPUSO una parada mid-trip (Lote C4): el driver-bff lo emite a la sala del viaje al
   * consumir `trip.waypoint_proposed`. El conductor ve el punto + costo adicional + tarifa nueva y
   * responde (acepta/rechaza) antes de `expiresAt`. No usa el sobre genérico: shape tipada y validada.
   */
  'waypoint:proposed': (msg: WaypointProposedMsg) => void;
}

export interface DriverClientToServer {
  /** GPS del conductor; el servidor responde por ack y publica `driver.location_updated` a Kafka. */
  location: (report: DriverLocationReport, ack: (res: DriverLocationAck) => void) => void;
}

/** Handshake del namespace /driver: access token (Bearer) en `auth.token` o header Authorization. */
export interface DriverHandshakeAuth {
  token: string;
}

export const DRIVER_NAMESPACE = '/driver';
