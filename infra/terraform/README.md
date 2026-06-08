# Infraestructura · Terraform

Toda la infra AWS de VEO declarada como código.

## Estructura

```
terraform/
├── modules/                # Módulos reutilizables (lo que cambia poco)
│   ├── vpc/                # VPC, subnets, NAT, VPC endpoints
│   ├── eks/                # EKS cluster + node groups + Karpenter
│   ├── rds-postgres/       # Postgres Multi-AZ con read replicas
│   ├── elasticache-redis/  # Redis cluster mode con failover
│   ├── msk-kafka/          # Managed Kafka 3 brokers
│   ├── s3-bucket/          # Buckets cifrados con SSE-KMS + Object Lock opcional
│   ├── cloudfront/         # CDN + WAF + signed URLs
│   ├── iam-roles/          # Roles por servicio con IRSA (IAM Roles for Service Accounts)
│   ├── kms/                # Customer Master Keys por dominio
│   └── iot-core/           # AWS IoT Core para MQTT
├── envs/                   # Composiciones por entorno
│   ├── dev/                # Cuenta dev separada
│   ├── staging/            # Pre-prod
│   └── prod/               # Producción Multi-AZ
└── shared/                 # Variables comunes y backend config
```

## Backend remoto

State en S3 + DynamoDB lock. Configurar `shared/backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "veo-tf-state"
    key            = "envs/<env>/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "veo-tf-lock"
    encrypt        = true
  }
}
```

## Aplicar

```bash
cd envs/dev
terraform init
terraform plan -out=plan.out
terraform apply plan.out
```

Producción usa Atlantis o Spacelift para PR-driven plan/apply — nunca `terraform apply` manual desde laptop.

## Convenciones

- Tags obligatorios: `Project=veo`, `Env=<env>`, `Owner=<team>`, `CostCenter=<center>`
- Nombre de recursos: `veo-<env>-<resource>` (ej. `veo-prod-rds-postgres`)
- Secretos NUNCA en `.tfvars` commiteados — usar AWS Secrets Manager + `aws_secretsmanager_secret_version`
- Cambios en `prod` requieren 2 aprobaciones en PR
