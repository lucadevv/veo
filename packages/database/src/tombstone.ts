/**
 * Derecho al olvido (BR-S06, Ley 29733) — decisión cliente: TOMBSTONE + anulación de PII.
 * Marca deletedAt, sobrescribe los campos PII con valores anónimos, y conserva el registro para
 * integridad referencial e historial sujeto a obligación legal (panic events, antifraude).
 * El borrado de media en S3 lo maneja el lifecycle (media-service), no esto.
 */

/** Delegate estructural de Prisma con `update`. */
export interface UpdatableDelegate {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface TombstoneOptions {
  /** Campos PII a anular (se setean a null o al placeholder indicado). */
  piiFields: string[];
  /** Placeholder para campos string no-nulos (ej. phone que es NOT NULL/UNIQUE). */
  placeholders?: Record<string, string>;
  /** Nombre de la columna de borrado lógico. Default 'deletedAt'. */
  deletedAtField?: string;
  now?: Date;
}

/**
 * Aplica tombstone a un registro: deletedAt = now, PII → null/placeholder.
 * Para columnas UNIQUE NOT NULL (ej. phone) usa un placeholder único por id para no violar constraints.
 */
export async function tombstone(
  delegate: UpdatableDelegate,
  id: string,
  opts: TombstoneOptions,
): Promise<void> {
  const deletedAtField = opts.deletedAtField ?? 'deletedAt';
  const data: Record<string, unknown> = { [deletedAtField]: opts.now ?? new Date() };
  for (const field of opts.piiFields) {
    data[field] = opts.placeholders?.[field] ?? null;
  }
  await delegate.update({ where: { id }, data });
}

/** Genera un placeholder único e irreversible para una columna UNIQUE (ej. phone). */
export function deletedPlaceholder(id: string, field: string): string {
  return `[deleted:${field}:${id}]`;
}
