-- CreateEnum
CREATE TYPE "places"."PlaceKind" AS ENUM ('HOME', 'WORK', 'FAVORITE');

-- CreateTable
CREATE TABLE "places"."saved_places" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" "places"."PlaceKind" NOT NULL,
    "label" TEXT NOT NULL,
    "subtitle" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saved_places_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_places_user_id_idx" ON "places"."saved_places"("user_id");
