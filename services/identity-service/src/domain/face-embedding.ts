/**
 * Predicado de ENROLAMIENTO BIOMÉTRICO (gate de seguridad server-side · diferenciador VEO).
 *
 * Fuente ÚNICA de la pregunta "¿el conductor tiene biometría facial de referencia enrolada?" — la
 * misma verdad que aplican el gate de aprobación (`approve`) y el gate de inicio de turno (`startShift`).
 * Extraído a un helper tipado para NO repetir la condición suelta en tres lados (DRY): si el predicado
 * cambia, cambia en UN solo lugar y los dos gates lo siguen.
 *
 * `Driver.faceEmbedding` es `Float[] @default([])` en el schema: NUNCA es null en filas materializadas,
 * pero el tipo de Prisma lo modela `number[]` (no-nullable). Aun así chequeamos `!emb` por defensa en
 * profundidad (lecturas parciales, proyecciones, datos legacy): vacío ⟹ NO enrolado. Sin strings mágicos.
 */
export function hasFaceEmbedding(driver: { faceEmbedding: number[] | null }): boolean {
  return Array.isArray(driver.faceEmbedding) && driver.faceEmbedding.length > 0;
}
