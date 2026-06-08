-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "share";

-- CreateTable
CREATE TABLE "share"."trusted_contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "otp_verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_modified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share"."share_links" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "contact_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 500,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share"."share_views" (
    "id" UUID NOT NULL,
    "share_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "share_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share"."trip_snapshots" (
    "trip_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "driver_id" UUID,
    "passenger_id" UUID,
    "started_at" TIMESTAMPTZ,
    "last_lat" DOUBLE PRECISION,
    "last_lon" DOUBLE PRECISION,
    "last_location_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_snapshots_pkey" PRIMARY KEY ("trip_id")
);

-- CreateTable
CREATE TABLE "share"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trusted_contacts_user_id_idx" ON "share"."trusted_contacts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_contacts_user_id_phone_key" ON "share"."trusted_contacts"("user_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share"."share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_trip_id_idx" ON "share"."share_links"("trip_id");

-- CreateIndex
CREATE INDEX "share_views_share_id_idx" ON "share"."share_views"("share_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "share"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "share"."share_links" ADD CONSTRAINT "share_links_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "share"."trusted_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share"."share_views" ADD CONSTRAINT "share_views_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "share"."share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

