/**
 * Error explícito para capacidades del esqueleto cuyo contrato en el public-bff
 * todavía NO existe (p. ej. contactos de confianza, modo niño standalone).
 *
 * No es un mock: NUNCA devuelve datos falsos. Falla de forma clara para que la próxima
 * oleada conecte el endpoint real cuando el BFF lo exponga.
 */
export class NotImplementedError extends Error {
  constructor(capability: string) {
    super(
      `[veo] capacidad no implementada aún (sin contrato en public-bff): ${capability}`,
    );
    this.name = 'NotImplementedError';
  }
}
