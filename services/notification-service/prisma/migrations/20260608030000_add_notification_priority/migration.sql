-- Prioridad de drenado: mayor = más urgente. Default 0 (Normal) para las filas existentes.
ALTER TABLE "notification"."notifications" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- El índice del worker pasa a incluir priority: filtra PENDING vencidas y ordena por (priority, antigüedad).
DROP INDEX "notification"."notifications_status_next_attempt_at_idx";
CREATE INDEX "notifications_status_priority_next_attempt_at_idx"
  ON "notification"."notifications" ("status", "priority", "next_attempt_at");
