# ADR-006 · LiveKit autohospedado para WebRTC

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Cámara en vivo del interior del vehículo es el pilar más caro y crítico. Necesitamos SFU regional con grabación cifrada server-side.

## Decisión

**LiveKit self-hosted** directo en el VPS (Docker Compose) desde Fase 1 (NO LiveKit Cloud, NO EKS — §0.7(c)). El **TURN server (coturn)** también se corre **self-hosted en el VPS**. El video nunca sale de **NUESTRO VPS**.

> Nota: STATUS ya decía "NO LiveKit Cloud" — este ADR estaba stale (asumía Cloud→EKS). La decisión de **LiveKit self-hosted** sobrevive; cambia el sustrato (VPS, no EKS) y se arranca self-hosted desde el día 1, sin etapa Cloud.

## Alternativas

- **Agora**: vendor lock-in, $5,200/mes a 50K MAU
- **Twilio Video**: deprecating Dec 2024 — DESCARTADO
- **Daily.co**: $3K/mes pero menor control
- **mediasoup self-hosted**: control total pero ops más complejas
- **Janus**: madurez OK pero ecosistema RN menor

## Consecuencias

- Compliance Ley 29733 — video nunca sale de **NUESTRO VPS** (§0.7(c))
- Sin vendor lock-in
- Recording server-side a **MinIO self-hosted** directo (NO S3 — §0.7(c))

* TURN servers requieren operación cuidadosa (Lima tiene NATs simétricos)
* Self-hosted necesita SRE maduro
