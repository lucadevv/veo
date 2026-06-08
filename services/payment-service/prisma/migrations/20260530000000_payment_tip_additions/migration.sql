-- CreateTable
CREATE TABLE "payment"."tip_additions" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "tip_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tip_additions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tip_additions_dedup_key_key" ON "payment"."tip_additions"("dedup_key");

-- CreateIndex
CREATE INDEX "tip_additions_payment_id_idx" ON "payment"."tip_additions"("payment_id");

-- CreateIndex
CREATE INDEX "tip_additions_trip_id_idx" ON "payment"."tip_additions"("trip_id");

-- AddForeignKey
ALTER TABLE "payment"."tip_additions" ADD CONSTRAINT "tip_additions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"."payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
