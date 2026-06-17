# ADR-003 · React Native para apps móviles

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Construir passenger (iOS+Android) + driver (Android prioritario) con requisitos no triviales: WebRTC, biometría, panic en background, GPS continuo.

## Decisión

**React Native 0.75+** con New Architecture (Fabric/TurboModules). Módulos nativos para panic, biometría, WebRTC, background location.

## Alternativas

- **Nativo puro (Swift+Kotlin)**: 2× esfuerzo y hiring. Justificable solo si performance crítica (no es el caso).
- **Flutter**: ecosistema WebRTC y SDKs peruanos de pago menos maduros.
- **PWA**: descartado — WebRTC + push background + secuencia volume keys oculta es imposible.

## Consecuencias

- 70% code reuse entre 3 builds
- Equipo mobile más pequeño (2 vs 4)
- react-native-webrtc oficial mantenido

* Native modules siguen siendo iOS+Android (no se ahorra ahí)
* Performance ~90% del nativo, no 100%
