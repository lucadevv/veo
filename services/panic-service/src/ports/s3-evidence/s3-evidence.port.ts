/**
 * Puerto de evidencia S3 (FOUNDATION §9). Riel externo (almacén de objetos) tras un puerto propio
 * e intercambiable. La evidencia de pánico se guarda con Object Lock (WORM): inmutable y no borrable
 * durante el periodo de retención, requisito legal/forense (Ley 29733 + cadena de custodia).
 *
 * Self-hosted: en dev/staging el riel es MinIO; en prod, almacén compatible S3 con Object Lock.
 */
export const S3_EVIDENCE_STORE = Symbol('S3_EVIDENCE_STORE');

export interface S3EvidenceStore {
  /**
   * Genera (sin I/O) las keys S3 reservadas para la evidencia de un pánico.
   * Las keys son deterministas/ordenables; media-service sube los objetos a estas rutas.
   * NO toca red → seguro de llamar en el hot path del trigger (<800ms).
   */
  reserveKeys(panicId: string, count: number): string[];

  /** Asegura que el bucket de evidencia existe con Object Lock habilitado. Idempotente. */
  ensureBucket(): Promise<void>;

  /**
   * Aplica retención WORM (Object Lock, modo COMPLIANCE) a objetos ya subidos por media-service.
   * Best-effort por objeto: registra los fallos pero no interrumpe el anexado de keys.
   * @returns las keys efectivamente protegidas.
   */
  protect(keys: string[]): Promise<string[]>;
}
