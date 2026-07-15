-- Dispatch policy v2 (feature-flag, ADITIVO). Todo nullable / con default → una fila v1 preexistente sigue
-- funcionando VERBATIM, sin reescritura de datos. El default de la DB coincide con el @default del
-- schema.prisma ('v1') a propósito (sin drift): a diferencia de las ventanas, acá el default vive en AMBOS.

-- Feature-flag de política + snapshot v2 por-modo (JSON). policy_version='v1' + policy_v2 NULL = actual.
ALTER TABLE "dispatch"."dispatch_radius_config" ADD COLUMN "policy_version" TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE "dispatch"."dispatch_radius_config" ADD COLUMN "policy_v2" JSONB;

-- Expansión TEMPORAL del ring del matcher FIXED v2 (nextExpandAt), desacoplada del timeout de la oferta.
-- Nullable: v1 (y v2 en maxK) la dejan NULL. El sweep filtra OPEN + next_expand_at ≤ now por este índice.
ALTER TABLE "dispatch"."dispatch_sessions" ADD COLUMN "next_expand_at" TIMESTAMPTZ;

-- CreateIndex (hot-path del sweep de expansión temporal v2)
CREATE INDEX "dispatch_sessions_status_next_expand_at_idx" ON "dispatch"."dispatch_sessions"("status", "next_expand_at");
