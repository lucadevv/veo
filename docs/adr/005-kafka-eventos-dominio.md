# ADR-005 · Kafka como event bus de dominio

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Eventos de dominio (`trip.requested`, `payment.captured`, `panic.triggered`) deben ser consumidos por múltiples servicios (audit, analytics, billing, notification).

## Decisión

**Kafka self-hosted en el VPS** para eventos de dominio (§0.7(c)). El fan-out simple (notifs, webhooks) se resuelve con **Kafka/Redis self-hosted**. **Redis Streams** (como bus primario) descartado.

> **OBSOLETO (SaaS AWS, §0.7(c)):** ~~AWS MSK~~ (Kafka es self-hosted), ~~SNS/SQS para fan-out~~ (se hace con Kafka/Redis), ~~AWS EventBridge~~. La decisión de **Kafka** sobrevive; lo que muere es el managed de AWS.

## Alternativas

- **Redis Streams**: pierde mensajes si cluster falla parcialmente
- **RabbitMQ**: menos retención y replay menos sólido
- **AWS EventBridge**: throughput limitado para nuestros volúmenes (además SaaS AWS — OBSOLETO por §0.7(c))

## Consecuencias

- Event sourcing del trip, replay para reconstrucción
- Múltiples consumidores independientes
- Retención de eventos (audit puede reconstruir 30 días)

* ~~MSK cuesta $480/mes a 50K MAU~~ (OBSOLETO: Kafka se corre self-hosted en el VPS, sin costo MSK — §0.7(c))
* Curva de aprendizaje (consumer groups, partitions, exactly-once)
