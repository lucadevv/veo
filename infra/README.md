# VEO Infrastructure

Infraestructura como código para VEO. Vive en `infra/` del monorepo único `lucadevv/veo`. Aunque comparte repo con el código de aplicación, mantiene su propia gobernanza:

- **Cadencia distinta**: cambios infra son semanales/mensuales vs deploys de app diarios
- **Reviewers distintos**: SRE + Tech Lead aprueban cambios de Terraform (vía CODEOWNERS sobre `infra/`)
- **Compliance**: cambios de IAM, KMS, RBAC, NetworkPolicies requieren label `security-review`
- **State separado**: Terraform state remoto (S3 + DynamoDB lock), nunca mezclado con código

## Ubicación en el monorepo

`infra/` contiene Terraform + K8s (Kustomize) + ArgoCD. El backend está en `services/`, las apps en `apps/`, los packages compartidos en `packages/`.

## Estructura

```
veo-infra/
├── terraform/
│   ├── modules/        # vpc, eks, rds-postgres, redis, msk, s3, cloudfront, iam, kms, iot-core
│   ├── envs/           # dev, staging, prod (cada uno con backend S3 propio)
│   └── shared/         # variables comunes
├── k8s/
│   ├── base/           # Kustomize base (16 services con template)
│   └── overlays/       # dev, staging, prod
└── argocd/
    ├── applications/   # apps por entorno
    └── projects/       # AppProject VEO
```

## Prerequisitos

- Terraform >= 1.9
- kubectl + kustomize
- AWS CLI con SSO configurado
- ArgoCD CLI (opcional para debugging)

## Aplicar Terraform

```bash
cd terraform/envs/dev
terraform init
terraform plan -out=plan.out
terraform apply plan.out
```

**Producción NO se aplica desde laptop.** Usar Atlantis o Spacelift para PR-driven plan/apply.

## Convenciones

- Tags obligatorios: `Project=veo`, `Env=<env>`, `Owner=<team>`, `CostCenter=<center>`
- Naming: `veo-<env>-<resource>` (ej. `veo-prod-rds-postgres`)
- Secretos NUNCA en `.tfvars` commiteados — AWS Secrets Manager via `aws_secretsmanager_secret_version`
- Cambios a `prod`: 2 aprobaciones de PR + freeze window (no viernes)

## Backend remoto

State en S3 + DynamoDB lock:

```hcl
backend "s3" {
  bucket         = "veo-tf-state"
  key            = "envs/<env>/terraform.tfstate"
  region         = "us-east-1"
  dynamodb_table = "veo-tf-lock"
  encrypt        = true
}
```

## Deploy de aplicaciones (GitOps via ArgoCD)

Cuando un servicio publica nueva imagen Docker (desde el CI del monorepo), ArgoCD detecta y aplica:

```bash
# Manual sync (raro, solo prod):
argocd app sync veo-prod

# Watch en vivo:
kubectl -n argocd get applications -w
```

## Cómo arrancar la infraestructura completa (orden)

```bash
# 1. Terraform aplica infra base
cd terraform/envs/dev && terraform apply

# 2. kubectl context apunta al cluster nuevo
aws eks update-kubeconfig --name veo-dev-eks --region us-east-1

# 3. Instalar componentes core (Karpenter, External Secrets, cert-manager, ingress-nginx, Linkerd, ArgoCD)
kubectl apply -f k8s/overlays/dev/bootstrap/

# 4. ArgoCD toma el control y sincroniza apps
kubectl apply -f argocd/applications/veo-dev.yaml
```

## Documentación

- [CLAUDE.md](./CLAUDE.md) — contexto para futuras sesiones AI
- [terraform/README.md](./terraform/README.md) — módulos y entornos
- [docs/runbooks/](./docs/runbooks/) — runbooks operativos (TODO)
- Blueprint maestro: `../VEO_Blueprint.pdf` (Cap. 10 infra AWS + observabilidad)
