# VEO Passenger App

React Native (iOS + Android) para pasajeros · Mercado: Lima, Perú · Idioma: español peruano

## Ubicación en el monorepo

Esta app vive en `apps/passenger/` del monorepo único [`lucadevv/veo`](../../README.md). El backend (`services/`), los packages `@veo/*` (`packages/`) y la infra (`infra/`) viven en el mismo repo. La app conductor está en `apps/driver/`.

## Prerequisitos

- Node 20 + pnpm 9
- Xcode 15+ con CocoaPods (iOS)
- Android Studio + JDK 17 (Android)

## Setup

```bash
# Desde la raíz del monorepo
git clone git@github.com:lucadevv/veo.git && cd veo
pnpm install                  # instala TODO el workspace (backend + apps)
pnpm dev-stack:up && pnpm dev  # backend (en otra terminal)

# Arrancar la app
cd apps/passenger
cp .env.example .env
pnpm ios     # o pnpm android
```

## Native modules críticos

| Módulo | Plataforma | Para qué |
|---|---|---|
| `PanicDetector` | iOS + Android | Secuencia 3× vol con UI engañosa |
| `BiometricReLogin` | iOS + Android | Re-login biométrico local (Face ID/huella vía Keychain/Keystore); sin SDK de terceros |
| `WebRTC` | iOS + Android | `react-native-webrtc` oficial |
| `BackgroundLocation` | iOS + Android | GPS durante viaje |

## Packages compartidos

Se consumen vía `workspace:*` desde `packages/` del monorepo (pnpm workspace, `node-linker=hoisted`). Metro los resuelve desde el código fuente:

```json
"@veo/shared-types": "workspace:*",
"@veo/api-client":   "workspace:*",
"@veo/utils":        "workspace:*",
"@veo/ui-kit":       "workspace:*"
```

Esto exige que veo-platform esté clonado como hermano. Ver [docs/shared-packages.md](./docs/shared-packages.md) para el setup completo.

**En CI/producción** se publican desde veo-platform a GitHub Packages y se consumen con versionado semver (`^0.1.0`).

## Comandos

```bash
pnpm dev                    # Metro bundler
pnpm ios | pnpm android
pnpm test
pnpm test:e2e:ios | :android
pnpm lint && pnpm typecheck
pnpm build:android:bundle   # AAB para Play Store
pnpm build:ios              # Archive para App Store
```

## Release independiente

Ciclo de release de mobile NO está acoplado a backend. Ver [docs/release.md](./docs/release.md) para el flujo fastlane.

## Firebase (FCM) — credenciales

El repo incluye **placeholders** para que el build y el arranque NO fallen sin credenciales reales:

- Android: `android/app/google-services.json` (package `pe.veo.passenger`, claves dummy)
- iOS: `ios/VEO/GoogleService-Info.plist` (bundle `pe.veo.passenger`, claves dummy)

La inicialización de FCM está **protegida** (gate por env + `try/catch`):

- iOS: `AppDelegate.mm` solo llama a `FIRApp configure` si existe `GoogleService-Info.plist` en el bundle.
- JS: `src/services/messaging.ts` solo inicializa si `FIREBASE_ENABLED=true` (ver `.env`).

**Para producción:** reemplaza ambos archivos por los descargados desde la consola de Firebase
(mismo package/bundle `pe.veo.passenger`) y pon `FIREBASE_ENABLED=true` en `.env`.

## Variables de entorno

`react-native-config` lee `.env` (ver `.env.example`). Copia y completa:

```bash
cp .env.example .env
```

## Documentación

- [CLAUDE.md](./CLAUDE.md) — contexto AI para esta app
- Blueprint maestro: `../VEO_Blueprint.pdf` (lógica de negocio + arquitectura)
