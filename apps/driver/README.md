# VEO Driver App

React Native · **Android** prioritario (95% del mercado conductor en Lima) · iOS en Fase 3

## Ubicación en el monorepo

Esta app vive en `apps/driver/` del monorepo único [`lucadevv/veo`](../../README.md). El backend (`services/`), los packages `@veo/*` (`packages/`) y la infra (`infra/`) viven en el mismo repo. La app pasajero está en `apps/passenger/`.

## Setup

```bash
# Desde la raíz del monorepo
git clone git@github.com:lucadevv/veo.git && cd veo
pnpm install                  # instala TODO el workspace (backend + apps)
pnpm dev-stack:up && pnpm dev  # backend (en otra terminal)

# Arrancar la app
cd apps/driver
cp .env.example .env
pnpm android
```

## Pantallas críticas

| Pantalla | Notas |
|---|---|
| Login | Cuenta específica de conductor |
| ShiftStart | **Verificación facial obligatoria** (liveness + match facial vía biometric-service propio, ONNX self-hosted). Bloquea turno si falla. |
| ShiftDashboard | Online/offline toggle + ganancias en tiempo real |
| TripIncoming | Aceptar/rechazar con timeout 12s |
| TripActive | Navegación + cámara automática + **UI engañosa si pánico** |
| Earnings | Diario / semanal / mensual con desglose |
| Documents | SOAT, licencia, tarjeta propiedad — alertas de vencimiento |
| Profile | Rating, métricas, configuración |

## Native modules requeridos (driver)

| Módulo | Para qué |
|---|---|
| `ForegroundServiceTrip` | Mantener GPS + cámara WebRTC corriendo en background sin que Android los mate |
| `BiometricFrameGrabber` | Captura facial nativa (Camera2 en Android, AVFoundation en iOS) → frames a biometric-service propio (ONNX) para liveness/match al inicio de turno |
| `BackgroundLocation` | GPS continuo, persiste reinicios |
| `WebRTC` | Publisher hacia LiveKit SFU |
| `DeceptivePanicUI` | Modo discreto cuando pasajero activa pánico — UI normal en pantalla |
| `MqttClient` | Cliente MQTT directo a AWS IoT Core (más eficiente que WS sobre red móvil flaky) |

## Por qué solo Android en Fase 1

- 95%+ conductores afiliados a flotas en Lima usan Android
- Flota provee hardware uniforme (tablets Samsung Tab Active con mount)
- iOS conductor llega en Fase 3 (post-stabilization)

## Packages compartidos

Mismo patrón que passenger: `@veo/*` vía `workspace:*` desde `packages/` del monorepo (pnpm workspace, `node-linker=hoisted`).

## Comandos

```bash
pnpm dev
pnpm android
pnpm test
pnpm test:e2e:android
pnpm build:android:bundle  # Para Play Store
```

## Documentación

- [CLAUDE.md](./CLAUDE.md) — contexto AI
- Blueprint maestro: `../VEO_Blueprint.pdf`
