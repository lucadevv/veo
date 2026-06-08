-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateTable
CREATE TABLE "audit"."audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "payload" JSONB NOT NULL,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "s3_object_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_event_id_key" ON "audit"."audit_log"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_hash_key" ON "audit"."audit_log"("hash");

-- CreateIndex
CREATE INDEX "audit_log_resource_type_resource_id_idx" ON "audit"."audit_log"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit"."audit_log"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_action_occurred_at_idx" ON "audit"."audit_log"("action", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_s3_object_key_idx" ON "audit"."audit_log"("s3_object_key");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "audit"."outbox_events"("published_at", "created_at");

-- ============================================================================
-- Append-only (defensa en profundidad a nivel de DB).
-- audit_log es WORM: DELETE prohibido siempre; UPDATE prohibido salvo el sello
-- write-once de s3_object_key (NULL -> valor) que escribe el relay de réplica.
-- Cualquier alteración de columnas inmutables (incluido el hash) es rechazada.
-- Esto NO sustituye al hash chain: el chain detecta manipulación a nivel de
-- storage/superusuario que pueda saltarse estos triggers.
-- ============================================================================
CREATE OR REPLACE FUNCTION "audit"."audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'audit_log es append-only: DELETE prohibido (seq=%)', OLD.seq;
  END IF;

  -- UPDATE: solo se permite estampar s3_object_key una vez (NULL -> valor).
  IF ( OLD.id            IS DISTINCT FROM NEW.id
    OR OLD.seq           IS DISTINCT FROM NEW.seq
    OR OLD.event_id      IS DISTINCT FROM NEW.event_id
    OR OLD.actor_id      IS DISTINCT FROM NEW.actor_id
    OR OLD.action        IS DISTINCT FROM NEW.action
    OR OLD.resource_type IS DISTINCT FROM NEW.resource_type
    OR OLD.resource_id   IS DISTINCT FROM NEW.resource_id
    OR OLD.ip            IS DISTINCT FROM NEW.ip
    OR OLD.user_agent    IS DISTINCT FROM NEW.user_agent
    OR OLD.occurred_at   IS DISTINCT FROM NEW.occurred_at
    OR OLD.payload       IS DISTINCT FROM NEW.payload
    OR OLD.prev_hash     IS DISTINCT FROM NEW.prev_hash
    OR OLD.hash          IS DISTINCT FROM NEW.hash
    OR OLD.created_at    IS DISTINCT FROM NEW.created_at ) THEN
    RAISE EXCEPTION 'audit_log es append-only: columnas inmutables no se pueden modificar (seq=%)', OLD.seq;
  END IF;

  IF (OLD.s3_object_key IS NOT NULL) THEN
    RAISE EXCEPTION 'audit_log.s3_object_key ya fue estampado (write-once, seq=%)', OLD.seq;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_no_update"
  BEFORE UPDATE ON "audit"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit"."audit_log_append_only"();

CREATE TRIGGER "audit_log_no_delete"
  BEFORE DELETE ON "audit"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit"."audit_log_append_only"();
