-- AlterTable
ALTER TABLE "panic"."panic_events" ADD COLUMN     "dispatched_at" TIMESTAMPTZ,
ADD COLUMN     "dispatched_by" UUID,
ADD COLUMN     "escalated_at" TIMESTAMPTZ,
ADD COLUMN     "escalated_by" UUID;
