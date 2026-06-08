# Backend remoto compartido
#
# El backend S3+DynamoDB se declara en cada envs/<env>/main.tf (no se puede usar
# variables en bloques backend, por eso esta inline por entorno). Este archivo
# documenta la convencion y los recursos de bootstrap que deben existir ANTES
# de `terraform init` en cualquier entorno.
#
# Bootstrap (crear una sola vez, fuera de este state, p.ej. cuenta de gestion):
#
#   aws s3api create-bucket --bucket veo-tf-state --region us-east-1
#   aws s3api put-bucket-versioning --bucket veo-tf-state \
#     --versioning-configuration Status=Enabled
#   aws s3api put-bucket-encryption --bucket veo-tf-state \
#     --server-side-encryption-configuration \
#     '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
#   aws s3api put-public-access-block --bucket veo-tf-state \
#     --public-access-block-configuration \
#     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
#   aws dynamodb create-table --table-name veo-tf-lock \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH \
#     --billing-mode PAY_PER_REQUEST --region us-east-1
#
# Backend declarado en cada entorno (ya configurado):
#
#   terraform {
#     backend "s3" {
#       bucket         = "veo-tf-state"
#       key            = "envs/<env>/terraform.tfstate"
#       region         = "us-east-1"
#       dynamodb_table = "veo-tf-lock"
#       encrypt        = true
#     }
#   }
