-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "media";

-- CreateTable
CREATE TABLE "media"."media_segments" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "s3_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "codec" TEXT NOT NULL DEFAULT 'h264',
    "encryption_key_id" TEXT NOT NULL,
    "retention_until" TIMESTAMPTZ,
    "accessed_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMPTZ,
    "egress_id" TEXT,
    "has_incident" BOOLEAN NOT NULL DEFAULT false,
    "has_panic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."video_access_requests" (
    "id" UUID NOT NULL,
    "segment_id" UUID,
    "trip_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_by_email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "signed_url_expires_at" TIMESTAMPTZ,
    "watermark" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_segments_trip_id_idx" ON "media"."media_segments"("trip_id");

-- CreateIndex
CREATE INDEX "media_segments_retention_until_idx" ON "media"."media_segments"("retention_until");

-- CreateIndex
CREATE INDEX "video_access_requests_trip_id_idx" ON "media"."video_access_requests"("trip_id");

-- CreateIndex
CREATE INDEX "video_access_requests_segment_id_idx" ON "media"."video_access_requests"("segment_id");

-- CreateIndex
CREATE INDEX "video_access_requests_requested_by_idx" ON "media"."video_access_requests"("requested_by");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "media"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "media"."video_access_requests" ADD CONSTRAINT "video_access_requests_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "media"."media_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- BR-S02: el motivo de una solicitud de acceso a video debe superar los 20 caracteres.
ALTER TABLE "media"."video_access_requests"
  ADD CONSTRAINT "video_access_requests_reason_min_len" CHECK (char_length("reason") > 20);
