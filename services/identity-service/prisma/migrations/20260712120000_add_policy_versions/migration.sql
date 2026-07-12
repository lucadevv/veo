-- CreateTable
CREATE TABLE "identity"."policy_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policy_key_version_key" ON "identity"."policy_versions"("policy_key", "version");

-- CreateIndex
CREATE INDEX "policy_versions_policy_key_version_idx" ON "identity"."policy_versions"("policy_key", "version" DESC);

-- AddForeignKey
ALTER TABLE "identity"."policy_versions" ADD CONSTRAINT "policy_versions_policy_key_fkey" FOREIGN KEY ("policy_key") REFERENCES "identity"."policies"("key") ON DELETE CASCADE ON UPDATE CASCADE;
