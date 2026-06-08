# Módulos nativos del conductor (Ola nativa)

Documenta los módulos nativos implementados, cómo se conectan a los puertos de dominio y el
comportamiento de compliance (UI engañosa al pánico). Todo es real, sin mocks.

## 1. LocationSource (GPS foreground + background)

- **Lib**: `react-native-background-geolocation` (Transistor Software, OSS, empotrable; sin SaaS).
- **Adaptador**: `src/features/realtime/data/sources/background-geolocation-source.ts` implementa el
  puerto `LocationSource`. Multiplexa una sola suscripción nativa para toda la app.
- **Conexión**: se inyecta en `LocationSourceProvider` desde `App.tsx`. `useLocationPublisher` envía
  cada `LocationSample` por el socket `/driver` (evento `location`) mientras hay turno activo.
- **Android**: la lib levanta su propio Foreground Service de tipo `location`.
- **iOS**: usa el background mode `location` declarado en `Info.plist`.

## 2. Foreground Service del turno/viaje (Android Kotlin)

- **Servicio**: `android/app/src/main/java/com/veodriver/foreground/ShiftForegroundService.kt`.
  Notificación persistente (canal `veo.driver.shift`, importancia baja), `START_STICKY`, tipos FGS
  `location|camera|microphone` calculados según permisos concedidos (evita `SecurityException` en
  Android 14+).
- **Módulo RN**: `ShiftForegroundModule.kt` (`start(title,text)`/`stop()`), registrado por
  `ShiftForegroundPackage.kt` en `MainApplication.getPackages()`. Compatible con New Architecture vía
  la capa de interop de RN 0.75.
- **Manifest**: `<service .../>` con `foregroundServiceType="location|camera|microphone"` + permisos
  `FOREGROUND_SERVICE_CAMERA`/`FOREGROUND_SERVICE_MICROPHONE`.
- **Puerto**: `features/shift/domain/ports/foreground-service.ts`; impl
  `features/shift/data/services/native-foreground-service.ts` (no-op en iOS). Inyectado en el
  contenedor DI (`foregroundService`).
- **Wiring**: `RealtimeManager` lo enciende mientras `onShift` y lo apaga al terminar el turno.
- **iOS**: sin FGS; el sistema usa `UIBackgroundModes` (location/audio/voip) ya declarados.

## 3. LiveKit publisher (cámara del habitáculo → LiveKit)

- **Lib**: `livekit-client` (OSS) sobre los globals de `react-native-webrtc` (`registerGlobals()` en
  `index.js`). Mismo patrón que el visor del pasajero, del lado de PUBLICACIÓN.
- **Impl**: `features/trips/data/services/livekit-trip-publisher.ts` (`Room.connect(url, token)` +
  `localParticipant.enableCameraAndMicrophone()`; captura cámara+micro reales y publica en la sala).
- **Puerto de token**: `features/trips/domain/ports/trip-media-publisher.ts` (`PublisherTokenPort`),
  impl HTTP `features/trips/data/services/http-publisher-token.ts`.
- **Contrato real**: `POST /media/rooms/:tripId/publisher-token` → `driverPublisherGrant`
  `{ url, token, room }` (token LiveKit con `canPublish`).
- **Wiring**: `TripMediaPublisherProvider` (App) + `useTripPublisher` en `TripActiveScreen`; publica
  mientras el viaje está `IN_PROGRESS`.

## 4. Captura biométrica de turno (cámara + liveness)

- **Frame-grabber nativo**: módulo `VeoBiometricFrameGrabber` (iOS `ios/VEODriver/VeoBiometricFrameGrabber.m`
  con AVFoundation; Android `android/.../biometric/BiometricFrameGrabberModule.kt` con Camera2). Abre la
  cámara frontal, captura una secuencia de JPEG (base64) o una foto, y libera la sesión por llamada
  (único dueño de la cámara; no compite con WebRTC). Adaptador JS:
  `features/shift/data/services/native-biometric-frame-grabber.ts` (puerto `BiometricFrameGrabber`).
- **Orquestador**: `features/shift/data/services/liveness-biometric-capture.ts` combina el frame-grabber
  con el backend: reto → `planForChallenge(action)` → captura de frames → verify → `sessionRef`.
- **Puerto backend**: `features/shift/domain/ports/biometric-backend.ts`, impl HTTP
  `features/shift/data/services/http-biometric-backend.ts` (esquemas zod de `@veo/api-client`).
- **Contratos reales** (JWT driver): `POST /drivers/biometric/enroll {photo}` ·
  `POST /drivers/shift/biometric/challenge` · `POST /drivers/shift/biometric/verify {challengeId,frames}`
  → `{sessionRef, score, livenessPassed, matchPassed}` → `POST /drivers/shift/start {sessionRef}`.
- **Errores tipados**: no enrolado (409/422 → `BiometricEnrollScreen`), rechazo de liveness/match,
  lockout (403, mensaje del backend), backend/cámara no disponibles.
- **Wiring**: `RealBiometricCaptureProvider` (App) → `ShiftStartScreen`/`useShiftStartFlow` y
  `BiometricEnrollScreen`/`useBiometricEnroll` (también accesible desde el perfil).
- **Reutilización en el alta (KYC del wizard)**: el paso de verificación facial del registro usa el
  MISMO módulo nativo `VeoBiometricFrameGrabber.capturePhoto()` a través de un puerto propio del
  feature (`registration/domain/ports/face-photo-grabber.ts`) implementado en
  `registration/data/services/native-face-capture.ts` (`NativeFacePhotoGrabber` + permiso de cámara
  Android; en iOS lo gestiona AVFoundation vía `NSCameraUsageDescription`). `NativeFaceCaptureService`
  entrega la foto base64 en `FaceCapture.photoBase64`, que `IdentityVerificationScreen` enrola con
  `POST /drivers/biometric/enroll`. Se inyecta con `RealFaceCaptureProvider` en `RegistrationNavigator`.
  No requiere dependencias nativas nuevas (reusa el módulo de cámara existente).

## 5. Re-login biométrico (LocalAuthService)

- **Lib**: `react-native-keychain` (Keychain iOS / Keystore Android, `BIOMETRY_CURRENT_SET`).
- **Impl**: `features/auth/data/services/keychain-local-auth.ts` (puerto `LocalAuthService`),
  inyectado en DI (`localAuth`).
- **Wiring**: `useLogin` guarda el refresh token bajo biometría; `useBiometricRelogin` lo desbloquea
  con Face ID/huella y refresca la sesión sin OTP (`LoginScreen`). `useLogout` lo borra.

## 6. Push (FCM/APNs)

- **Lib**: `@react-native-firebase/messaging` (carga protegida; dev sandbox/log con placeholder).
- **Impl**: `features/notifications/data/fcm-push-service.ts` (permisos, token, handlers
  foreground/quita + background en `index.js`). Registro/baja de token: puerto
  `features/notifications/domain/ports/push.ts` + impl `http-push-registration.ts`.
- **Contratos reales**: `POST /notifications/device-token {token, platform}` (204) ·
  `DELETE /notifications/device-token/:token` (204). El cuerpo se valida con el esquema
  `registerDevice` de `@veo/api-client`.
- **Wiring**: `PushManager` (navegador autenticado) registra el token; `useLogout` lo da de baja con el
  JWT aún vigente antes de limpiar la sesión. En sandbox sin Firebase degrada a log (no inventa token).

## 7. UI engañosa al pánico (regla #2) — comportamiento

El app del conductor **nunca** revela que el pasajero activó pánico:

- **Contrato del socket**: el namespace `/driver` (`DriverServerToClient` en `@veo/api-client`) solo
  emite `dispatch:offer`, `dispatch:match`, `trip:update`. Los eventos `panic:alert`/`panic:update`
  existen únicamente en el namespace de **ops/admin**, al que el conductor no se conecta. Garantía a
  nivel de contrato: el conductor no recibe eventos de pánico.
- **Cancelación de seguridad**: si un `trip:update` llega con el viaje cancelado por un protocolo de
  pánico, la UI lo muestra como un estado **normal/inocuo** (p. ej. "Cancelado"), sin alertas ni
  indicadores que delaten el motivo.
- **Push**: todos los handlers (foreground/background/quita) descartan cualquier mensaje cuyo
  `data.type` sugiera pánico (`panic`/`sos`/`emergency`/`panico`) y **no** muestran UI.
- **Sin estados de pánico en el cliente**: no existe store, pantalla ni indicador de pánico en el app
  del conductor.
