-- AUTO-suspensión del conductor por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad).
-- dispatch-service decide la suspensión (evento `driver.excessive_cancellations`, al cruzar el umbral en la
-- ventana rolling de 24h) e identity la materializa como un hold con esta NUEVA causa. A diferencia de las
-- otras causas automáticas, este hold es TEMPORAL (`expires_at` seteado): un sweeper lo auto-levanta al vencer
-- el cooldown (ver migración 20260623160000_driver_suspension_hold_expires_at). Igual que las demás causas
-- NO-disciplinarias, la levanta también el override de compliance del operador (reactivateForCompliance).
--
-- AISLAMIENTO TRANSACCIONAL: en Postgres, `ALTER TYPE ... ADD VALUE` históricamente NO puede correr dentro de
-- un bloque transaccional junto a statements que USEN el valor nuevo. Esta migración agrega el valor y NADA MÁS
-- (no lo referencia), así que es segura. Migración PROPIA (un solo statement) para no acoplarla a ningún uso del
-- valor en la misma transacción.

-- AlterEnum
ALTER TYPE "identity"."SuspensionCause" ADD VALUE 'EXCESSIVE_CANCELLATIONS';
