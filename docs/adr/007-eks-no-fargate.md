# ADR-007 · EKS sobre ECS Fargate

> **REEMPLAZADO (2026-06-24)** por el modelo VPS self-hosted (FOUNDATION §0.7(c)): producción es VPS único + Docker Compose + GitHub Actions. EKS/Karpenter/Linkerd-as-mesh/External-Secrets quedan obsoletos. Este ADR se conserva como registro histórico.

**Estado:** Reemplazado (modelo VPS) · **Fecha:** 2026-05-27

## Contexto

14 servicios desacoplados + frontends. Necesitamos orquestación + auto-scaling + service mesh capable.

## Decisión

**EKS** con Karpenter (spot instances) + Linkerd service mesh + External Secrets Operator.

## Alternativas

- **ECS Fargate**: más simple ops pero ~30% más caro a esta escala, networking limitado para SFU
- **EKS Fargate**: parcial Fargate aún más caro
- **ECS EC2**: descartado, EKS es estándar

## Consecuencias

- Portabilidad GKE/AKS (manifests K8s estándar)
- Karpenter para spot saving ~40%
- Service mesh capable (mTLS interno)

* Curva de aprendizaje K8s (mitigado: ya estándar en LATAM senior)
* Control plane $73/mes extra
