# VEO Passenger App

React Native (iOS + Android) para pasajeros · Mercado: Lima, Perú · Idioma: español peruano

## Repos hermanos

| Repo | Propósito |
|---|---|
| **veo-passenger-app** (este) | App pasajero iOS + Android |
| [veo-driver-app](../veo-driver-app) | App conductor (Android) |
| [veo-platform](../veo-platform) | Servicios backend + BFFs + admin-web + family-web + packages compartidos |
| [veo-infra](../veo-infra) | Terraform + K8s + ArgoCD (producción) |

## Prerequisitos

- Node 20 + pnpm 9
- Xcode 15+ con CocoaPods (iOS)
- Android Studio + JDK 17 (Android)

## Setup

```bash
git clone git@github.com:veo/veo-passenger-app.git
cd veo-passenger-app
pnpm install
cp .env.example .env

# Levantar el backend (repo hermano)
cd ../veo-platform && pnpm dev-stack:up && pnpm dev

# Volver y arrancar la app
cd ../veo-passenger-app
pnpm ios     # o pnpm android
```

## Native modules críticos

| Módulo | Plataforma | Para qué |
|---|---|---|
| `PanicDetector` | iOS + Android | Secuencia 3× vol con UI engañosa |
| `BiometricReLogin` | iOS + Android | Re-login biométrico local (Face ID/huella vía Keychain/Keystore); sin SDK de terceros |
| `WebRTC` | iOS + Android | `react-native-webrtc` oficial |
| `BackgroundLocation` | iOS + Android | GPS durante viaje |

## Packages compartidos (consumidos desde veo-platform)

**Durante desarrollo** se consumen vía `file:` apuntando al repo hermano:

```json
"@veo/shared-types": "file:../veo-platform/packages/shared-types",
"@veo/api-client":   "file:../veo-platform/packages/api-client",
"@veo/utils":        "file:../veo-platform/packages/utils",
"@veo/ui-kit":       "file:../veo-platform/packages/ui-kit"
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
