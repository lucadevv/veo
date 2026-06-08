-- CreateTable
CREATE TABLE "identity"."consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "data_processing" BOOLEAN NOT NULL,
    "in_cabin_camera" BOOLEAN NOT NULL,
    "location" BOOLEAN NOT NULL,
    "policy_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consents_user_id_accepted_at_idx" ON "identity"."consents"("user_id", "accepted_at");
