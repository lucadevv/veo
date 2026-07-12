-- Preferencias in-app de notificaciones por usuario (una fila por usuario). Fuente de verdad
-- server-side: reemplaza la persistencia solo-local (MMKV) del passenger para sincronizar entre
-- dispositivos. `user_id` lo fija el BFF desde la identidad firmada. Ausencia de fila = defaults.
CREATE TABLE "notification"."notification_preferences" (
    "user_id" TEXT NOT NULL,
    "trip_status" BOOLEAN NOT NULL DEFAULT true,
    "driver_en_route" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_reminders" BOOLEAN NOT NULL DEFAULT true,
    "offers" BOOLEAN NOT NULL DEFAULT false,
    "news" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);
