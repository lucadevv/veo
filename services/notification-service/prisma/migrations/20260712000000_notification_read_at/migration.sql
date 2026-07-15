-- Bandeja in-app: marca de LECTURA por notificación. NULL = no leído (las filas existentes quedan
-- como no leídas, comportamiento honesto: nunca se marcaron). Lo sella PATCH /notifications/:id/read
-- y PATCH /notifications/read-all. El cliente deriva `read = read_at IS NOT NULL` (ya no lo inventa).
ALTER TABLE "notification"."notifications" ADD COLUMN "read_at" TIMESTAMPTZ;
