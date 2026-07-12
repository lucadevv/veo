-- Pantalla "Detalle de operador" (staff): la lista/detalle del panel muestra Nombre y Último acceso.
-- Dos columnas NUEVAS en admin_users, ambas NULLABLE (backfill implícito NULL, sin default de datos):
--  · name          — nombre legible del operador (el alta por invitación aún no lo pide → null por ahora).
--  · last_login_at  — timestamp del último login EXITOSO (lo escribe identity al emitir tokens). Null hasta el 1er login.

-- AlterTable
ALTER TABLE "identity"."admin_users"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "last_login_at" TIMESTAMPTZ;
