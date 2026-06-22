/**
 * U3 · CTA que dice QUÉ falta. Deriva — de forma TIPADA, sin strings mágicos — la clave i18n del "Te falta: X"
 * que se muestra PEGADA al CTA primario cuando éste está disabled. La fuente es el MISMO gating que ya gobierna
 * el botón (`hasReadDni`/`licenseUploaded` en Conductor; tarjeta/foto/SOAT en Vehículo): no duplica la lógica,
 * la traduce a feedback. El orden del array refleja la SECUENCIA de pasos (1, 2, 3…): se reporta el PRIMER
 * requisito incumplido, así el conductor sabe exactamente el próximo paso.
 */

/** Un requisito del paso: si está cumplido y la clave i18n del "te falta" cuando no lo está. */
export interface StepRequirement {
  /** ¿El requisito ya está satisfecho? (deriva del gating existente del screen). */
  readonly satisfied: boolean;
  /** Clave i18n del texto "te falta este requisito" (tipada por el caller con `as const`). */
  readonly missingKey: string;
}

/**
 * Devuelve la clave i18n del PRIMER requisito incumplido, o `null` si todos están satisfechos (el CTA estaría
 * habilitado). El orden del array ES la prioridad/secuencia de pasos.
 */
export function firstMissingRequirement(requirements: readonly StepRequirement[]): string | null {
  const pending = requirements.find((r) => !r.satisfied);
  return pending ? pending.missingKey : null;
}
