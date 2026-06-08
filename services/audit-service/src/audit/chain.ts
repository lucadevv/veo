/**
 * Hash chain del audit log (BR audit · Ley 29733).
 * Funciones PURAS (sin I/O) para calcular y verificar la cadena → testeables sin DB.
 *
 * Cada entrada calcula `hash = chainHash(prevHash, serialize(content))`.
 * `prevHash` es el hash de la entrada anterior (null en la GENESIS).
 * Alterar cualquier campo de una entrada cambia su hash y rompe el enlace con la siguiente
 * → manipulación detectable de forma determinista.
 */
import { chainHash } from '@veo/utils';

/** Contenido inmutable de una entrada (lo que entra al hash). NO incluye seq/hash/prevHash. */
export interface AuditEntryContent {
  eventId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip: string;
  userAgent: string;
  occurredAt: Date | string;
  payload: Record<string, unknown>;
}

/** Fila persistida de la cadena (lo que se lee de la DB para verificar). */
export interface ChainRow extends AuditEntryContent {
  seq: bigint | number;
  prevHash: string | null;
  hash: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  /** Nº de entradas verificadas. */
  checked: number;
  /** seq de la primera entrada que falló (si valid=false). */
  brokenAtSeq?: string;
  /** Motivo del fallo. */
  reason?: 'CONTENT_TAMPERED' | 'BROKEN_LINK' | 'GENESIS_PREV_HASH';
}

/**
 * Serialización canónica determinista (claves ordenadas recursivamente) del contenido.
 * Independiente del orden de claves del JSON → estable tras round-trip por Postgres JSONB.
 * `occurredAt` se normaliza a ISO-8601 (UTC).
 */
export function serializeAuditEntry(content: AuditEntryContent): string {
  const canonical = {
    eventId: content.eventId,
    actorId: content.actorId,
    action: content.action,
    resourceType: content.resourceType,
    resourceId: content.resourceId,
    ip: content.ip,
    userAgent: content.userAgent,
    occurredAt: new Date(content.occurredAt).toISOString(),
    payload: content.payload,
  };
  return stableStringify(canonical);
}

/** Calcula el hash de una entrada dado el hash previo. */
export function computeEntryHash(prevHash: string | null, content: AuditEntryContent): string {
  return chainHash(prevHash, serializeAuditEntry(content));
}

export interface VerifyChainOptions {
  /**
   * Si true, exige que la primera fila tenga prevHash = null (verificación desde GENESIS).
   * Para rangos parciales (que no empiezan en seq=1) debe ser false: el enlace de borde con
   * la entrada anterior se confía, pero el contenido se recomputa igual.
   */
  expectGenesis?: boolean;
}

/**
 * Recorre la cadena (ordenada por seq asc) y detecta tampering:
 *  1) recomputa el hash de cada fila a partir de su contenido → detecta alteración de campos.
 *  2) verifica el enlace: prevHash de la fila i == hash de la fila i-1.
 */
export function verifyChain(
  rows: ChainRow[],
  options: VerifyChainOptions = {},
): ChainVerificationResult {
  let previousHash: string | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    if (i === 0) {
      if (options.expectGenesis && row.prevHash !== null) {
        return {
          valid: false,
          checked: i,
          brokenAtSeq: String(row.seq),
          reason: 'GENESIS_PREV_HASH',
        };
      }
    } else if (row.prevHash !== previousHash) {
      return { valid: false, checked: i, brokenAtSeq: String(row.seq), reason: 'BROKEN_LINK' };
    }

    const recomputed = computeEntryHash(row.prevHash, row);
    if (recomputed !== row.hash) {
      return {
        valid: false,
        checked: i,
        brokenAtSeq: String(row.seq),
        reason: 'CONTENT_TAMPERED',
      };
    }

    previousHash = row.hash;
  }

  return { valid: true, checked: rows.length };
}

/** JSON.stringify determinista con claves ordenadas recursivamente. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
