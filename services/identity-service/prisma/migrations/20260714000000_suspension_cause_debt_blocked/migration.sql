-- ADR-022 §P-A · TOPE de deuda CASH: cuando payment-service reporta que un conductor cruzó el tope de deuda por
-- comisiones de viajes en efectivo (`driver.debt_exceeded`), identity lo BLOQUEA con un hold de esta NUEVA causa
-- (DEBT_BLOCKED). Como DOCUMENT_EXPIRED/CATEGORY_DISABLED es una causa AUTOMÁTICA (NO-disciplinaria), pero su
-- reactivación es EXCLUSIVA de `driver.debt_cleared` (el conductor SALDÓ por el rail): NO la levanta el override de
-- compliance del operador (saldar es la única forma) ni el sweeper de expiración (es un hold PERMANENTE). A
-- diferencia de DISCIPLINARY, el bloqueo por deuda NO revoca la sesión (el viaje EN CURSO se termina normal).
--
-- AISLAMIENTO TRANSACCIONAL: en Postgres, `ALTER TYPE ... ADD VALUE` no debe correr junto a statements que USEN el
-- valor nuevo en la misma transacción. Esta migración agrega el valor y NADA MÁS (no lo referencia) → segura.

-- AlterEnum
ALTER TYPE "identity"."SuspensionCause" ADD VALUE 'DEBT_BLOCKED';
