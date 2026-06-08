# CLAUDE.md · VEO Infrastructure

> 🟢 **Estado global y handoff:** lee `../veo-platform/docs/STATUS.md` (qué se hizo, dónde quedamos, qué falta) y
> `../veo-platform/docs/FOUNDATION.md` (contrato + decisiones). **Regla maestra:** soberanía tecnológica (todo propio, sin SaaS de terceros).
> Infra (Ola 5) aún no implementada a detalle. Decisión clave: **RDS por servicio crítico** (identity/payment/panic/audit). CI GitHub Actions por repo.

## Repo

Terraform + K8s + ArgoCD para VEO. Separado del código de aplicación.

## Reglas no negociables

1. **NUNCA aplicar `terraform apply` a prod desde laptop.** Solo via Atlantis/Spacelift PR-driven.
2. **State remoto siempre.** S3 + DynamoDB lock. Backend declarado en cada `envs/<env>/main.tf`.
3. **Secretos JAMÁS en `.tfvars` commiteados.** Usar AWS Secrets Manager.
4. **Cambios a prod requieren 2 approvals** + freeze window respetado (no viernes/finde).
5. **Tags obligatorios** en todo recurso: `Project`, `Env`, `Owner`, `CostCenter`.
6. **KMS keys separadas por dominio**: `pii`, `biometric`, `video`, `audit`. Rotación anual obligatoria.
7. **Multi-AZ desde día 1**: 3 AZ en us-east-1. NUNCA desplegar SA en una sola AZ.
8. **NetworkPolicies default-deny** en K8s. Cada flujo se permite explícitamente.

## Layout

```
terraform/
├── modules/        ← 10 módulos reutilizables
└── envs/{dev,staging,prod}/
    ├── main.tf     ← instancia módulos
    ├── variables.tf
    ├── outputs.tf
    └── terraform.tfvars.example
k8s/
├── base/           ← Kustomize templates por servicio
└── overlays/{dev,staging,prod}/
argocd/
├── applications/   ← veo-dev.yaml, veo-staging.yaml, veo-prod.yaml
└── projects/       ← veo.yaml
```

## Comandos críticos

```bash
# Plan + apply (solo dev local)
cd terraform/envs/dev
terraform init && terraform plan -out=plan.out && terraform apply plan.out

# Refresh kubeconfig
aws eks update-kubeconfig --name veo-prod-eks --region us-east-1

# Ver estado de ArgoCD
kubectl -n argocd get applications

# Rollback de un servicio
kubectl -n veo-prod rollout undo deployment/<svc>

# Drain de nodo
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

## Cómo se relaciona con veo-platform

- veo-platform CI builda imágenes Docker y las push a ECR
- veo-platform actualiza tag en `k8s/overlays/<env>/replicas.yaml` o similar (vía PR a este repo)
- ArgoCD detecta el cambio y sincroniza

## Cambios prohibidos sin reviewer security

- Cambios a IAM (roles, policies)
- Cambios a KMS (key policies, rotation)
- Cambios a RBAC en K8s
- Cambios a NetworkPolicies
- Cambios a Audit log retention
- Apertura de Security Groups a 0.0.0.0/0

Cualquier PR que toque estos archivos debe etiquetarse `security-review` y bloquearse hasta aprobación de security engineer.

## Documentos

- Blueprint: `../VEO_Blueprint.pdf` (Cap. 10 infra)
- ADRs: `../veo-platform/docs/adr/` (compartidos)
