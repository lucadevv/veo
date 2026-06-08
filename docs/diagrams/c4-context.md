# Diagramas C4 · Nivel 1 (Contexto)

```mermaid
C4Context
  title VEO · Contexto del sistema

  Person(passenger, "Pasajero", "Usuario que solicita viajes en Lima")
  Person(driver, "Conductor", "Conduce vehículo afiliado a VEO")
  Person(family, "Familiar", "Contacto de confianza, ve viaje en vivo")
  Person(operator, "Operador Central", "Monitorea flota 24/7 y atiende pánicos")
  Person(supervisor, "Supervisor Compliance", "Aprueba accesos a video, audita")

  System(veo, "VEO Platform", "Plataforma de movilidad segura · 2 apps + dashboard + servicios")

  System_Ext(maps, "Google Maps", "Routing, distance, geocoding")
  System_Ext(yape, "Yape / Plin", "Pagos móviles peruanos")
  System_Ext(facetec, "FaceTec / Onfido", "Verificación biométrica")
  System_Ext(fcm, "FCM / APNs", "Push notifications")
  System_Ext(twilio, "Twilio", "SMS panic + OTP")
  System_Ext(pnp, "PNP / Serenazgo", "Respuesta de emergencia (Fase 4)")

  Rel(passenger, veo, "Solicita viaje, ve cámara, comparte con familia")
  Rel(driver, veo, "Acepta viajes, navega, captura video")
  Rel(family, veo, "Ve mapa + cámara via link firmado, sin app")
  Rel(operator, veo, "Monitorea flota, responde pánicos")
  Rel(supervisor, veo, "Aprueba accesos a video con audit")

  Rel(veo, maps, "Routing, distance matrix")
  Rel(veo, yape, "Procesar pagos")
  Rel(veo, facetec, "Verificar liveness al inicio de turno")
  Rel(veo, fcm, "Push a apps")
  Rel(veo, twilio, "SMS de pánico + OTP")
  Rel(veo, pnp, "Webhook de pánico (Fase 4)")
```

## Otros niveles

- `c4-containers.md` — Nivel 2: containers/servicios (TODO)
- `c4-component-trip.md` — Nivel 3: componentes de trip-service (TODO)
- `c4-component-panic.md` — Nivel 3: componentes de panic-service (TODO)
