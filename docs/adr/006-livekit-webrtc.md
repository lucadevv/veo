# ADR-006 · LiveKit autohospedado para WebRTC

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Cámara en vivo del interior del vehículo es el pilar más caro y crítico. Necesitamos SFU regional con grabación cifrada server-side.

## Decisión

**LiveKit Cloud** en Fase 1 (0–10K MAU) → migrar a **LiveKit self-hosted en EKS** en Fase 3. Mismo SDK, migración transparente.

## Alternativas

- **Agora**: vendor lock-in, $5,200/mes a 50K MAU
- **Twilio Video**: deprecating Dec 2024 — DESCARTADO
- **Daily.co**: $3K/mes pero menor control
- **mediasoup self-hosted**: control total pero ops más complejas
- **Janus**: madurez OK pero ecosistema RN menor

## Consecuencias

- Compliance Ley 29733 — video nunca sale de cuenta AWS
- Sin vendor lock-in
- Recording server-side a S3 directo

* TURN servers requieren operación cuidadosa (Lima tiene NATs simétricos)
* Self-hosted necesita SRE maduro
