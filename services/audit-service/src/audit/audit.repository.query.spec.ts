/**
 * buildQueryWhere — el predicado de lectura del audit log (compartido por `query` y `queryForExport`).
 *
 * FOCO: la búsqueda por NOMBRE de operador. El WORM guarda solo el `actorId` (hash); el bff resuelve nombre→ids
 * contra el roster y los pasa como `actorIds`. Verificamos que el predicado combine `q` (substring) con
 * `actorId IN actorIds` en UN SOLO OR (un row matchea si `q` matchea O el actor está en la lista) y que
 * `actorIds` vacío/ausente deje el WHERE EXACTO a como era antes (sin regresión).
 */
import { describe, it, expect } from 'vitest';
import { buildQueryWhere } from './audit.repository';
import type { Prisma } from '../generated/prisma';

/** Extrae el ÚNICO bloque OR del AND del WHERE (la "búsqueda libre"). null si no hay OR. */
function searchOr(where: Prisma.AuditLogWhereInput): Prisma.AuditLogWhereInput[] | null {
  const and = (where as { AND?: Prisma.AuditLogWhereInput[] }).AND ?? [];
  const withOr = and.find((c) => 'OR' in c) as { OR?: Prisma.AuditLogWhereInput[] } | undefined;
  return withOr?.OR ?? null;
}

describe('buildQueryWhere · búsqueda por nombre (actorIds ⊕ q)', () => {
  it('actorIds set → el OR incluye `actorId IN actorIds` AUNQUE q no matchee el id del actor', () => {
    // El operador teclea un nombre ("Ana"); el bff ya resolvió sus ids opacos (no contienen "Ana").
    const where = buildQueryWhere({ q: 'Ana', actorIds: ['op-1', 'op-2'] });
    const or = searchOr(where);
    expect(or).not.toBeNull();
    // La fila del actor "op-1"/"op-2" matchea por el IN, aunque su id no contenga la substring "Ana".
    expect(or).toContainEqual({ actorId: { in: ['op-1', 'op-2'] } });
    // Y SIGUE matcheando por las 4 substrings de q (no se pierde la búsqueda libre original).
    expect(or).toContainEqual({ action: { contains: 'Ana', mode: 'insensitive' } });
    expect(or).toContainEqual({ actorId: { contains: 'Ana', mode: 'insensitive' } });
    // Es UN solo OR combinado: 4 clausulas de q + 1 IN.
    expect(or).toHaveLength(5);
  });

  it('actorIds set SIN q → el OR es solo el `IN` (búsqueda puramente por nombre resuelto)', () => {
    const where = buildQueryWhere({ actorIds: ['op-9'] });
    expect(searchOr(where)).toEqual([{ actorId: { in: ['op-9'] } }]);
  });

  it('actorIds VACÍO con q → WHERE idéntico a hoy (solo las 4 substrings de q, sin IN) — no regresión', () => {
    const conEmpty = buildQueryWhere({ q: 'DR-11', actorIds: [] });
    const sinCampo = buildQueryWhere({ q: 'DR-11' });
    expect(conEmpty).toEqual(sinCampo);
    const or = searchOr(conEmpty);
    expect(or).toEqual([
      { action: { contains: 'DR-11', mode: 'insensitive' } },
      { resourceType: { contains: 'DR-11', mode: 'insensitive' } },
      { resourceId: { contains: 'DR-11', mode: 'insensitive' } },
      { actorId: { contains: 'DR-11', mode: 'insensitive' } },
    ]);
    // No hay clausula IN en ningún lado.
    expect(or!.some((c) => 'actorId' in c && typeof (c as { actorId?: unknown }).actorId === 'object' && (c as { actorId: { in?: unknown } }).actorId.in !== undefined)).toBe(false);
  });

  it('sin q y sin actorIds → no se agrega ningún OR (WHERE trae lo más reciente, como hoy)', () => {
    expect(searchOr(buildQueryWhere({}))).toBeNull();
    // Con solo un filtro estructurado (category) tampoco aparece OR de búsqueda libre.
    expect(searchOr(buildQueryWhere({ category: 'driver' }))).toBeNull();
  });
});
