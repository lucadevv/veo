-- ADR-018 · Verificación de identidad del pasajero PROGRESIVA (badge de confianza, no muro pre-viaje).
-- Estado inicial del KYC = UNVERIFIED (antes se conflaba con PENDING → el pasajero "en revisión" sin haber
-- hecho nada). UNVERIFIED = "no arrancó"; el pasajero se auto-verifica OPCIONALMENTE (liveness → VERIFIED).
--
-- AISLAMIENTO TRANSACCIONAL (igual que la migración de RATING_LOW): en Postgres, `ALTER TYPE ... ADD VALUE`
-- históricamente NO puede correr en el MISMO bloque transaccional que un statement que USE el valor nuevo
-- (p. ej. `SET DEFAULT 'UNVERIFIED'` castea el literal al enum = uso). Por eso esta migración agrega el valor
-- y NADA MÁS; el cambio de default a UNVERIFIED va en una migración PROPIA y POSTERIOR (ya commiteado el valor).
-- Se coloca ANTES de 'PENDING' para que el orden del enum en una DB migrada coincida con el schema (cosmético).

-- AlterEnum
ALTER TYPE "identity"."KycStatus" ADD VALUE 'UNVERIFIED' BEFORE 'PENDING';
