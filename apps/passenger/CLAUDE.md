# CLAUDE.md · VEO Passenger App

> 🟢 **Estado global y handoff:** lee `../../docs/STATUS.md` (qué se hizo, dónde quedamos, qué falta) y
> `../../docs/FOUNDATION.md` (contrato + decisiones, §0.7 soberanía). **Regla maestra:** soberanía tecnológica = todo lo self-hosteable se self-hostea, sin SaaS de terceros para el DATO ni el CÓMPUTO sensibles (biometría, video, pánico, audit, PII → propios/self-hosted). SOLO sobreviven los rieles de transporte físicamente imposibles de self-hostear (push FCM/APNs, red de pagos Yape/Plin, SMS de operador), tras un puerto propio intercambiable y sin PII en el payload. Soberanía es seguridad del dato, no “cero proveedores”.
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
  - **Auto-sanado anti-stale (red de seguridad, solo `__DEV__` con Metro vivo):** si igual quedó un override
    **baked** en tu `.env` cuyo host NO es el host vivo de Metro — IP LAN rotada por DHCP, **dominio de un túnel
    muerto** (el bug del driver 2026-07-03), o `localhost` en device físico — la app **lo ignora y usa el host
    VIVO de Metro** — un Reload reconecta, **sin rebuild nativo** (`env.ts` es JS, lo bundlea Metro; solo los
    VALORES del `.env` se bakean, y se leen en runtime). Avisa por `console.warn` para que no sea magia
    silenciosa. Para apuntar un build dev a staging/túnel/IP fija A PROPÓSITO: `DEV_FORCE_ENV_URLS=true` en el
    `.env` (los `preview.env` ya lo traen). Los **release** (`!__DEV__`) NO se tocan: el `.env` manda siempre ahí.
- **WebRTC** se conecta directo a LiveKit (no via BFF) usando token emitido por `media-service`.

## Reglas no negociables

1. **Panic detection vive en native module**, no en JS. Funciona en background. Latencia objetivo de fan-out backend < 3s (validado por synthetic monitoring).
2. **UI del pánico debe ser INVISIBLE.** Sin botón visible (configurable). Solo secuencia oculta 3× volume. Excepción: usuarios pueden activar botón visible alternativo en settings.
3. **Cámara en vivo NO requiere consentimiento adicional por trip** — se aceptó al ingreso (Auth). Pero la app DEBE mostrar el indicador "REC" visible.
4. **Modo niño**: el código NUNCA se muestra en la app del conductor. Se valida hash en backend.
5. **i18n es-PE primero.** Si se agrega es-ES o en-US después, mantener Lima/Perú como default.
6. **Performance crítica**: Map debe correr a 60fps. Reanimated 3 obligatorio para gestures. Evitar re-renders innecesarios en pantallas de viaje.
7. **Persistencia con MMKV**, no AsyncStorage (3-5x más rápido). AsyncStorage solo para data efímera.

## Flujo de diseño — MCP Pencil + verificación en simulador (OBLIGATORIO)

La **fuente de verdad visual** es `design/veo.pen` (repo del plano). Al migrar/construir CUALQUIER pantalla de UI, este ciclo NO es opcional:

1. **Leé el frame del `.pen` FRESCO con el MCP `pencil`** (`get_screenshot` + `batch_get`) — el `.pen` es multiplayer y cambia; NUNCA de memoria. Confirmá primero con `get_editor_state` que el archivo activo es el `veo.pen` correcto. Buscá TODAS las frames del flujo por nombre (`batch_get` con `patterns`): un flujo puede tener `P/X`, `P/X-2`, `P/X-3` (ej. onboarding = 3 frames).
2. **Extraé los NÚMEROS del diseño, no los adivines del screenshot** (la causa raíz de las infidelidades pasadas era construir "a ojo" desde la imagen):
   - `get_variables` → los **tokens exactos** (colores, spacing, fonts). Mapealos a los tokens de `@veo/ui-kit` (`themes.ts`); si un valor del `.pen` no existe como token, PARAR y resolver el token primero — jamás hardcodear el hex "que se ve".
   - `snapshot_layout` → la **estructura numérica del layout** (posiciones, tamaños, orden, apilado-vs-lado-a-lado, solapados). Esto es lo que define fila-vs-columna, no tu lectura del screenshot.
3. **Construí CONFORMANDO al `.pen`** (layout, orden, componentes, tokens). Los `.pen` están cifrados: solo se leen por el MCP `pencil`, jamás con Read/grep.
4. **Verificá en DOS pasadas**:
   a. **Numérica**: volvé a correr `snapshot_layout` del frame y compará contra lo que construiste (orden de hijos, dirección fila/columna, visible/oculto, spacing). Los números no opinan.
   b. **Visual**: en el simulador con `mobile-mcp`/`metro-mcp`, **COMPARÁ LADO A LADO** screenshot del sim vs `get_screenshot` del `.pen`. **"Se ve fiel" NO alcanza** — enumerá las diferencias REALES (posición, orden, visible/oculto, apilado-vs-lado-a-lado, botón/label) y corregí en loop hasta que calce. (Este paso se salteó una vez y se entregó Auth con Google/Apple apilados en vez de lado a lado + OTP oculto — no repetir.)
5. **Copy en TUTEO peruano** aunque el `.pen` esté en voseo (`src/i18n/locales/es-PE/voseoGuard.test.ts` rompe el build ante voseo). El `.pen` manda en DISEÑO, no en dialecto.
6. **Assets del `.pen`**: copialos OPTIMIZADOS (resize a resolución de device + JPG, ~100-200KB), no los PNG crudos. Si tienen barra de estado/menú del celular, recortá el chrome (solo contenido) con ImageMagick.

## Pantallas críticas (priorizadas)

| Pantalla                    | Fase  | Notas                                                                                    |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| Onboarding                  | F1    | Carrusel marketing 3 slides (design/veo.pen). Los consents Ley 29733 viven en Auth       |
| Auth (phone + OTP)          | F1    | OTP 6 díg (SMS SMPP) + los 3 consentimientos Ley 29733 INLINE (design/veo.pen P/Auth)    |
| KycCamera                   | F1-F2 | Captura facial nativa → biometric-service propio (ONNX self-hosted), sin SDK de terceros |
| Home (mapa + request)       | F1    | MapLibre GL + tiles OSM self-hosted (tileserver-gl)                                      |
| TripActive (cámara + share) | F2    | WebRTC viewer + botón compartir familia                                                  |
| Panic                       | F2    | UI mínima, native module                                                                 |
| TrustedContacts             | F2    | Hasta 3, OTP cada uno                                                                    |
| ChildMode                   | F2    | Input código 4-6 dígitos                                                                 |
| Profile + Payments          | F1-F4 | Yape/Plin F1, tarjeta F4                                                                 |
| TripHistory                 | F1    | Lista paginada con detalles                                                              |

## Stack mobile

- React Native 0.85 con New Architecture
- React Navigation 6
- React Query (server state) + Zustand (client state) + Redux Toolkit (donde aplique para slices grandes)
- Reanimated 3 (gestures, transitions)
- MapLibre + tiles OSM self-hosted (NO Google Maps)
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
