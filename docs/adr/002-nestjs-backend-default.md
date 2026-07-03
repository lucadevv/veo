# ADR-002 · NestJS como framework backend por defecto

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Necesitamos un framework para 14 servicios backend con DI, validación, observabilidad y curva de aprendizaje razonable para devs TS/JS.

## Decisión

**NestJS 10** para 11 microservicios + 3 BFFs. Excepción: `tracking-service` migra a **Go** en Fase 3 cuando peak WS > 10K conexiones.

## Alternativas

- **Express/Fastify directo**: menos estructura, refactor más caro con 14 servicios.
- **Go desde día 1**: throughput mejor pero curva de aprendizaje y hiring 2x. Justificable solo para tracking-service.
- **Elixir/Phoenix**: superior para real-time pero talent pool LATAM muy pequeño.

## Consecuencias

- Mismo lenguaje (TS) en backend + frontend
- DI, decorators, módulos limpios
- Ecosistema npm completo (Yape/Plin/FCM SDKs)

* Node sufre GC con > 3K conexiones WS por nodo (mitigado: Go para tracking-service)
* Más boilerplate que Express
