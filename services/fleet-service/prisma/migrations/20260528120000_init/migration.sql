-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fleet";

-- CreateEnum
CREATE TYPE "fleet"."FleetDocumentType" AS ENUM ('LICENSE_A1', 'SOAT', 'PROPERTY_CARD', 'BACKGROUND_CHECK', 'ITV');

-- CreateEnum
CREATE TYPE "fleet"."FleetDocumentStatus" AS ENUM ('PENDING_REVIEW', 'VALID', 'EXPIRING_SOON', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "fleet"."FleetOwnerType" AS ENUM ('DRIVER', 'VEHICLE');

-- CreateEnum
CREATE TYPE "fleet"."VehicleDocStatus" AS ENUM ('VALID', 'EXPIRING_SOON', 'EXPIRED');

-- CreateTable
CREATE TABLE "fleet"."vehicles" (
    "id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "fleet_id" TEXT,
    "doc_status" "fleet"."VehicleDocStatus" NOT NULL DEFAULT 'VALID',
    "insurance_expires_at" TIMESTAMPTZ,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."fleet_documents" (
    "id" UUID NOT NULL,
    "owner_type" "fleet"."FleetOwnerType" NOT NULL,
    "owner_id" TEXT NOT NULL,
    "type" "fleet"."FleetDocumentType" NOT NULL,
    "document_number" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "file_s3_key" TEXT,
    "status" "fleet"."FleetDocumentStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "last_alerted_days" INTEGER,
    "verified_at" TIMESTAMPTZ,
    "verified_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fleet_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."inspections" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "inspector_id" UUID NOT NULL,
    "inspected_at" TIMESTAMPTZ NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "notes" TEXT,
    "next_due_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plate_key" ON "fleet"."vehicles"("plate");

-- CreateIndex
CREATE INDEX "vehicles_fleet_id_idx" ON "fleet"."vehicles"("fleet_id");

-- CreateIndex
CREATE INDEX "vehicles_doc_status_idx" ON "fleet"."vehicles"("doc_status");

-- CreateIndex
CREATE INDEX "fleet_documents_owner_type_owner_id_idx" ON "fleet"."fleet_documents"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "fleet_documents_status_expires_at_idx" ON "fleet"."fleet_documents"("status", "expires_at");

-- CreateIndex
CREATE INDEX "inspections_vehicle_id_inspected_at_idx" ON "fleet"."inspections"("vehicle_id", "inspected_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "fleet"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "fleet"."inspections" ADD CONSTRAINT "inspections_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "fleet"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

