# VEO Driver App

React Native · **Android** prioritario (95% del mercado conductor en Lima) · iOS en Fase 3

## Repos hermanos

| Repo | Propósito |
|---|---|
| **veo-driver-app** (este) | App conductor Android |
| [veo-passenger-app](../veo-passenger-app) | App pasajero iOS + Android |
| [veo-platform](../veo-platform) | Servicios backend + BFFs + admin-web + family-web + packages compartidos |
| [veo-infra](../veo-infra) | Terraform + K8s + ArgoCD (producción) |

## Setup

```bash
git clone git@github.com:veo/veo-driver-app.git
cd veo-driver-app
pnpm install
cp .env.example .env

# Backend (repo hermano)
cd ../veo-platform && pnpm dev-stack:up && pnpm dev

# Volver y arrancar
cd ../veo-driver-app
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

Mismo patrón que passenger: `file:../veo-platform/packages/*` en dev, GitHub Packages en CI/prod.

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
