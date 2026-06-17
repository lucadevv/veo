-- CreateTable
CREATE TABLE "trip"."fuel_surcharge_config" (
    "id" TEXT NOT NULL,
    "surcharge_cents_per_km" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fuel_surcharge_config_pkey" PRIMARY KEY ("id")
);
