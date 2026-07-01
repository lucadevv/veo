-- ADR-018 · Estado inicial del KYC = UNVERIFIED. Cambia el DEFAULT de la columna `kyc_status` de PENDING a
-- UNVERIFIED: todo usuario nuevo (pasajero o conductor) nace UNVERIFIED ("no arrancó ningún KYC").
--
-- Migración SEPARADA de la que agrega el valor 'UNVERIFIED' (20260701000000): ese valor ya está COMMITEADO
-- por la migración anterior, así que este `SET DEFAULT 'UNVERIFIED'` (que USA el valor) corre seguro en su
-- propia transacción — evita el "unsafe use of new value of enum type" de Postgres.
--
-- ALCANCE (Lote 1): solo cambia el DEFAULT para inserts NUEVOS. NO reescribe las filas existentes en PENDING
-- (esa migración de datos idempotente es el Lote 2 de la ADR-018): las filas ya verificadas quedan intactas.

-- AlterTable
ALTER TABLE "identity"."users" ALTER COLUMN "kyc_status" SET DEFAULT 'UNVERIFIED';
