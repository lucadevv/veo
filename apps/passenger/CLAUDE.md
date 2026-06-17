# CLAUDE.md · VEO Passenger App

> 🟢 **Estado global y handoff:** lee `../veo-platform/docs/STATUS.md` (qué se hizo, dónde quedamos, qué falta) y
> `../veo-platform/docs/FOUNDATION.md` (contrato + decisiones). **Regla maestra:** soberanía tecnológica = control del DATO sensible (biometría, video, pánico, audit, PII → propios/self-hosted); los rieles de transporte externos inevitables (push FCM/APNs, pagos, SMS) SÍ se usan, tras puerto propio y sin PII en el payload. Soberanía es seguridad del dato, no “cero proveedores”.
> Esta app (Ola 4) aún no empieza; el backend `identity-service` ya está listo como referencia.

## Repo

App pasajero React Native (iOS + Android). Parte de un sistema multi-repo:

- **veo-passenger-app** (este)
- veo-driver-app
- veo-platform (backend)
- veo-infra (Terraform + K8s)

## Cómo se conecta con el resto

- **Tipos y SDK** vienen de `veo-platform/packages/*` via `file:` link en dev. En CI/prod via GitHub Packages.
- **API** se llama vía `public-bff` (puerto 4001 en dev local, `api.veo.pe/passenger` en prod).
- **WebSocket** para tracking via `socket.io-client` apuntando a `public-bff`.
- **URL del BFF en dev — NO hardcodees la IP.** `src/core/config/env.ts` resuelve `PUBLIC_BFF_URL` en 3 niveles:
  (1) `.env` explícito (gana; úsalo para staging/prod), (2) **auto-derivada del host de Metro** (`metroDevHost()`
  = la IP ACTUAL de la Mac), (3) fallback `localhost` (iOS/sim) / `10.0.2.2` (emulador Android).
  → **Dejá `PUBLIC_BFF_URL`/`PUBLIC_BFF_WS_URL` VACÍOS en tu `.env` de dev**: la app sigue tu IP sola (un
  Reload de Metro), sin recompilar. Ojo: `localhost` solo sirve en el simulador iOS — en un **device físico**
  localhost es el device, no la Mac (por eso la auto-derivación, que cubre los 3 casos).
  - **Auto-sanado anti-IP-stale (red de seguridad, solo `__DEV__`):** si igual quedó una **IP LAN baked**
    (`192.168.x.y` / `10.x` / `172.16–31.x`) en tu `.env` y el DHCP te rotó la IP, la app **ignora el `.env`
    stale y usa el host VIVO de Metro** — un Reload reconecta, **sin rebuild nativo** (`env.ts` es JS, lo bundlea
    Metro; solo los VALORES del `.env` se bakean, y se leen en runtime). Avisa por `console.warn` para que no sea
    magia silenciosa. URLs con **dominio** (staging/prod) y los **release** (`!__DEV__`) NO se tocan: el `.env`
    manda siempre ahí. Esto mata el "sin conexión" por IP vieja sin que dependas de acordarte de vaciar el `.env`.
- **WebRTC** se conecta directo a LiveKit (no via BFF) usando token emitido por `media-service`.

## Reglas no negociables

1. **Panic detection vive en native module**, no en JS. Funciona en background. Latencia objetivo de fan-out backend < 3s (validado por synthetic monitoring).
2. **UI del pánico debe ser INVISIBLE.** Sin botón visible (configurable). Solo secuencia oculta 3× volume. Excepción: usuarios pueden activar botón visible alternativo en settings.
3. **Cámara en vivo NO requiere consentimiento adicional por trip** — se aceptó al onboarding. Pero la app DEBE mostrar el indicador "REC" visible.
4. **Modo niño**: el código NUNCA se muestra en la app del conductor. Se valida hash en backend.
5. **i18n es-PE primero.** Si se agrega es-ES o en-US después, mantener Lima/Perú como default.
6. **Performance crítica**: Map debe correr a 60fps. Reanimated 3 obligatorio para gestures. Evitar re-renders innecesarios en pantallas de viaje.
7. **Persistencia con MMKV**, no AsyncStorage (3-5x más rápido). AsyncStorage solo para data efímera.

## Pantallas críticas (priorizadas)

| Pantalla                    | Fase  | Notas                                                                                    |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| Onboarding                  | F1    | Consentimientos Ley 29733 explícitos                                                     |
| Auth (phone + OTP)          | F1    | OTP a 6 dígitos vía notification-service propio (SMS soberano por SMPP)                  |
| KycCamera                   | F1-F2 | Captura facial nativa → biometric-service propio (ONNX self-hosted), sin SDK de terceros |
| Home (mapa + request)       | F1    | MapLibre GL + tiles OSM self-hosted (tileserver-gl)                                      |
| TripActive (cámara + share) | F2    | WebRTC viewer + botón compartir familia                                                  |
| Panic                       | F2    | UI mínima, native module                                                                 |
| TrustedContacts             | F2    | Hasta 3, OTP cada uno                                                                    |
| ChildMode                   | F2    | Input código 4-6 dígitos                                                                 |
| Profile + Payments          | F1-F4 | Yape/Plin F1, tarjeta F4                                                                 |
| TripHistory                 | F1    | Lista paginada con detalles                                                              |

## Stack mobile

- React Native 0.75 con New Architecture
- React Navigation 6
- React Query (server state) + Zustand (client state) + Redux Toolkit (donde aplique para slices grandes)
- Reanimated 3 (gestures, transitions)
- react-native-maps (Google Maps)
- react-native-webrtc
- MMKV (persistencia)
- i18next + react-i18next (i18n)

## Comandos esenciales

```bash
pnpm dev                  # Metro
pnpm pod:install          # iOS deps (después de cambios en native modules)
pnpm ios                  # Build + run iOS
pnpm android              # Build + run Android
pnpm test                 # Jest
pnpm test:e2e:ios         # Detox (App Store-ready)
pnpm build:android:bundle # AAB para Play Store
```

## Release a stores

Cadencia: 2 semanas (cuando aplique). Fastlane configurado en `fastlane/`.

- iOS: TestFlight → App Store
- Android: Internal track → Closed beta → Production

Versionado independiente del backend. Backend mantiene compatibilidad N-2 con app.

## Documentos de referencia

- Blueprint: `../VEO_Blueprint.pdf` (Cap. 4 inventario passenger, Cap. 6 flujos)
- Backend API contracts: `../veo-platform/services/*/docs`
