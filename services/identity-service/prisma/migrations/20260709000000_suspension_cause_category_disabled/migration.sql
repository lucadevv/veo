-- SEAM catálogo↔operabilidad (ADR 013): cuando el admin DESACTIVA del catálogo la última oferta de una CLASE
-- de vehículo, los conductores de esa clase se SUSPENDEN (no pueden iniciar turno ni quedar en línea) con un
-- hold de esta NUEVA causa; al re-activar la clase, fleet reporta la reincorporación y el hold se levanta.
-- Igual que DOCUMENT_EXPIRED/INSPECTION_EXPIRED es una causa AUTOMÁTICA (NO-disciplinaria), pero su reactivación
-- es EXCLUSIVA del evento de re-activación de la clase: NO la levanta el override de compliance del operador
-- (lo haría con la categoría aún apagada → reabriría el hueco) ni el sweeper de expiración (es un hold PERMANENTE).
--
-- AISLAMIENTO TRANSACCIONAL: en Postgres, `ALTER TYPE ... ADD VALUE` históricamente NO puede correr dentro de un
-- bloque transaccional junto a statements que USEN el valor nuevo. Esta migración agrega el valor y NADA MÁS
-- (no lo referencia), así que es segura. La mantenemos como migración PROPIA (un solo statement), igual que
-- RATING_LOW/EXCESSIVE_CANCELLATIONS, para no acoplarla a ningún uso del valor en la misma transacción.

-- AlterEnum
ALTER TYPE "identity"."SuspensionCause" ADD VALUE 'CATEGORY_DISABLED';
