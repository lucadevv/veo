# ADR-005 · Kafka como event bus de dominio

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Eventos de dominio (`trip.requested`, `payment.captured`, `panic.triggered`) deben ser consumidos por múltiples servicios (audit, analytics, billing, notification).

## Decisión

**Kafka (AWS MSK)** para eventos de dominio. **SNS/SQS** para fan-out simple (notifs, webhooks). **Redis Streams** descartado.

## Alternativas

- **Redis Streams**: pierde mensajes si cluster falla parcialmente
- **RabbitMQ**: menos retención y replay menos sólido
- **AWS EventBridge**: throughput limitado para nuestros volúmenes

## Consecuencias

- Event sourcing del trip, replay para reconstrucción
- Múltiples consumidores independientes
- Retención de eventos (audit puede reconstruir 30 días)

* MSK cuesta $480/mes a 50K MAU
* Curva de aprendizaje (consumer groups, partitions, exactly-once)
