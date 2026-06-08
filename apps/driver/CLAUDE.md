# CLAUDE.md · VEO Driver App

> 🟢 **Estado global y handoff:** lee `../veo-platform/docs/STATUS.md` (qué se hizo, dónde quedamos, qué falta) y
> `../veo-platform/docs/FOUNDATION.md` (contrato + decisiones). **Regla maestra:** soberanía tecnológica (todo propio, sin SaaS de terceros).
> Esta app (Ola 4) aún no empieza; el backend `identity-service` ya está listo como referencia (incluye gate biométrico de turno).

## Repo

App conductor React Native Android. Parte de un sistema multi-repo:

- veo-passenger-app
- **veo-driver-app** (este)
- veo-platform (backend)
- veo-infra (Terraform + K8s)

## Cómo se conecta con el resto

- **Tipos y SDK** desde `veo-platform/packages/*` (file: en dev, GitHub Packages en prod).
- **API** vía `driver-bff` (puerto 4002 dev, `api.veo.pe/driver` prod).
- **GPS upstream**: MQTT directo a AWS IoT Core (mejor que WS sobre red móvil flaky).
- **WebRTC publisher**: directo a LiveKit con token de `media-service`.

## Reglas no negociables

1. **Verificación biométrica obligatoria al iniciar turno.** Si falla 3 veces, bloqueo 1h. Sin override de UI — solo central puede destrabar.
2. **UI engañosa al pánico del pasajero.** El conductor debe ver UI normal/aleatoria. NO mostrar nada que delate que el pasajero activó pánico.
3. **Foreground Service obligatorio en Android.** Sin esto, Android mata GPS + WebRTC en background → no podemos cumplir el SLA.
4. **Min SDK 26 (Android 8.0).** Cubre 95% del mercado conductor en Lima. Hardware mínimo: 3 GB RAM, 64 GB storage.
5. **No mostrar info del pasajero hasta aceptar.** Solo distancia + tarifa estimada. Datos completos post-aceptación.
6. **Modo noche por defecto.** Conductores trabajan muchas horas en condiciones de poca luz.

## Hardware certificado (recomendado por la flota)

- Samsung Galaxy Tab Active5 (lo que la flota provee)
- Samsung A23, A24, A33 (BYOD aceptable)
- Min: 3 GB RAM, Android 8+, GPS L1+L5

## Stack mobile

Igual al passenger-app excepto:
- **react-native-mqtt** (publish GPS a IoT Core)
- **ForegroundService nativo** (Android), no equivalente iOS hasta F3

## Comandos

```bash
pnpm dev
pnpm android
pnpm build:android:bundle  # AAB para Play Store
```

## Release a Play Store

- Internal track (qa) → Closed beta (flota piloto) → Open beta (todos conductores) → Production
- Force update cuando hay cambios de compliance o de protocolo de pánico

## Documentos

- Blueprint: `../VEO_Blueprint.pdf` (Cap. 4 inventario driver)
- Native modules driver-specific: `docs/native-modules/` (TODO)
