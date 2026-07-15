# Diagramas C4 · Nivel 1 (Contexto)

```mermaid
C4Context
  title VEO · Contexto del sistema

  Person(passenger, "Pasajero", "Usuario que solicita viajes en Lima")
  Person(driver, "Conductor", "Conduce vehículo afiliado a VEO")
  Person(family, "Familiar", "Contacto de confianza, ve viaje en vivo")
  Person(operator, "Operador Central", "Monitorea flota 24/7 y atiende pánicos")
  Person(supervisor, "Supervisor Compliance", "Aprueba accesos a video, audita")

  System(veo, "VEO Platform", "Plataforma de movilidad segura · 2 apps + dashboard + servicios. Capacidades sensibles self-hosted (§0.7): routing OSM propio, biometría ONNX propia, SMS por SMPP soberano")

  System_Ext(whatsapp, "WhatsApp Cloud API", "Entrega OTP (canal PRINCIPAL · excepción §0.7 acotada · tras puerto WhatsAppSender)")
  System_Ext(yape, "Yape / Plin", "Pagos móviles peruanos (red de pagos)")
  System_Ext(fcm, "FCM / APNs", "Push notifications (riel nativo Google/Apple)")
  System_Ext(smpp, "SMS de operador (SMPP)", "Entrega OTP — FALLBACK soberano vía SMPP 3.4 directo al operador")
  System_Ext(pnp, "PNP / Serenazgo", "Respuesta de emergencia (Fase 4)")

  Rel(passenger, veo, "Solicita viaje, ve cámara, comparte con familia")
  Rel(driver, veo, "Acepta viajes, navega, captura video")
  Rel(family, veo, "Ve mapa + cámara via link firmado, sin app")
  Rel(operator, veo, "Monitorea flota, responde pánicos")
  Rel(supervisor, veo, "Aprueba accesos a video con audit")

  Rel(veo, whatsapp, "Enviar OTP (principal)")
  Rel(veo, smpp, "Enviar OTP (fallback) + SMS de pánico")
  Rel(veo, yape, "Procesar pagos")
  Rel(veo, fcm, "Push a apps")
  Rel(veo, pnp, "Webhook de pánico (Fase 4)")
```

> **Soberanía (§0.7):** routing/geocoding (OSM propio: OSRM/Valhalla + Nominatim vía `@veo/maps`) y biometría
> (`biometric-service` ONNX self-hosted) NO son sistemas externos — viven dentro de `VEO Platform`. Como externos
> quedan SOLO los rieles inevitables legítimos: WhatsApp Cloud API (OTP principal, excepción acotada ADR-012),
> FCM/APNs (push), red de pagos Yape/Plin, y SMS de operador vía SMPP (fallback soberano).

## Otros niveles

- `c4-containers.md` — Nivel 2: containers/servicios (TODO)
- `c4-component-trip.md` — Nivel 3: componentes de trip-service (TODO)
- `c4-component-panic.md` — Nivel 3: componentes de panic-service (TODO)
