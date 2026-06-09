-- Bandeja in-app (findInboxByRecipient): filtra por (recipient_id, channel='PUSH') y ordena por
-- created_at DESC. El índice de 2 columnas (recipient_id, created_at) no cubre `channel`, así que
-- Postgres filtraba el canal post-índice. Este índice de 3 columnas sirve el WHERE+ORDER sin sort.
CREATE INDEX IF NOT EXISTS "notifications_recipient_id_channel_created_at_idx"
  ON "notification"."notifications" ("recipient_id", "channel", "created_at");
