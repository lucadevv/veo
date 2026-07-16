-- Drop de `users.dni_hash` (decisión §14, TASK-008): campo MUERTO — ningún flujo lo escribía (el KYC del
-- pasajero es liveness+faceEmbedding, sin DNI) y el doc de identidad del pasajero vive en `users.document`
-- (doc de pago Yape On File, en claro por decisión del dueño). Data-minimization Ley 29733: columna sin
-- productor ni consumidor = fuera del schema. El blind index del CONDUCTOR (`drivers.dni_hash`, @unique
-- para dedup) NO se toca.
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "dni_hash";
