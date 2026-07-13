/**
 * AuditService (lectura) — proxea las consultas de auditoría a audit-service (REST interno firmado)
 * y mapea a la vista pública auditEntryView de @veo/api-client. Paginación por cursor `beforeSeq`.
 *
 * ENRIQUECIMIENTO del ACTOR (accountability · Ley 29733): el WORM guarda solo el `actorId` (hash de identidad).
 * El panel muestra nombre + rol del operador que ejecutó la acción → se resuelve on-read contra el ROSTER de
 * operadores (identity GET /admin/operators), MISMO patrón que el enrich del solicitante en MediaService. Es
 * best-effort y anti-N+1 (UNA lectura del roster por página); si no resuelve (actor que no es un operador del
 * staff — un conductor/pasajero/sistema de un evento de dominio, o el roster cae) degrada HONESTO a solo-id.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditEntryView } from '@veo/api-client';
import { REST_AUDIT, REST_IDENTITY } from '../infra/tokens';
import { AuditRecorder } from './audit-recorder.service';
import type { AuditQueryDto, AuditVerifyDto } from './dto/audit-query.dto';

interface AuditEntryResponse {
  id: string;
  seq: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
}

/** Respuesta CRUDA de audit-service (`GET /audit/verify`). El bff la remapea a la forma del front. */
interface UpstreamVerifyResponse {
  valid: boolean;
  checked: number;
  fromSeq: string | null;
  toSeq: string | null;
  brokenAtSeq?: string;
  reason?: string;
}

/**
 * Forma del verify HACIA el front (schema `auditChainVerification` de @veo/api-client): el bff es el boundary que
 * le da forma. Remapea `checked→checkedEntries`, normaliza `brokenAtSeq` a `null` (el schema lo exige PRESENTE,
 * nullable ≠ optional) y stampa `verifiedAt` = instante en que corrió la verificación (la chequeo es síncrona).
 */
export interface VerifyResponse {
  valid: boolean;
  checkedEntries: number;
  brokenAtSeq: string | null;
  verifiedAt: string;
}

/** Fila del roster de operadores (identity GET /admin/operators) — subset usado para enriquecer al actor. */
interface OperatorRow {
  id: string;
  name: string | null;
  roles: string[];
}

/** Identidad enriquecida del actor (STAFF · accountability): nombre + rol primario. `null` si no se resolvió. */
interface ActorIdentity {
  name: string | null;
  role: string | null;
}

/** Filtros estructurados que el bff propaga a audit-service (listado + export comparten forma). */
interface AuditFilters {
  category?: string;
  q?: string;
  from?: string;
  to?: string;
}

const DEFAULT_LIMIT = 50;

@Injectable()
export class AuditService {
  constructor(
    @Inject(REST_AUDIT) private readonly rest: InternalRestClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  async list(
    identity: AuthenticatedUser,
    query: AuditQueryDto,
  ): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const entries = await this.rest.get<AuditEntryResponse[]>('/audit', {
      identity,
      query: {
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        actorId: query.actorId,
        action: query.action,
        category: query.category,
        q: query.q,
        from: query.from,
        to: query.to,
        limit,
        // El panel emite `cursor` (= último seq cargado); audit-service lo consume como `beforeSeq`.
        beforeSeq: query.cursor,
      },
    });
    const directory = await this.actorDirectory(identity, entries);
    const items = entries.map((e) => toAuditEntryView(e, directory.get(e.actorId ?? '')));
    // El listado viene en orden descendente por seq; el siguiente cursor es el seq del último.
    const nextCursor = items.length === limit ? (items[items.length - 1]?.seq ?? null) : null;
    return { items, nextCursor };
  }

  /**
   * Export CSV del SET COMPLETO del filtro (GET /audit/export) — MISMO patrón que el export de finanzas: el corte
   * es SERVER-SIDE (audit-service devuelve el set entero sin paginar, acotado por su tope duro), acá enriquecemos
   * el actor (roster de operadores), formateamos el CSV y AUDITAMOS la exportación (accountability de acceso al
   * libro de compliance · Ley 29733). Devuelve el CSV como string; el controller le pone los headers de descarga.
   */
  async exportAudit(identity: AuthenticatedUser, filters: AuditFilters): Promise<string> {
    const entries = await this.rest.get<AuditEntryResponse[]>('/audit/export', {
      identity,
      query: {
        category: filters.category,
        q: filters.q,
        from: filters.from,
        to: filters.to,
      },
    });
    const directory = await this.actorDirectory(identity, entries);
    const csv = buildAuditCsv(entries, directory);
    await this.audit.record(identity, {
      action: 'audit.export',
      resourceType: 'audit_log',
      resourceId: filters.category && filters.category !== 'ALL' ? filters.category : 'ALL',
      payload: { rowCount: entries.length },
    });
    return csv;
  }

  async verify(identity: AuthenticatedUser, query: AuditVerifyDto): Promise<VerifyResponse> {
    const raw = await this.rest.get<UpstreamVerifyResponse>('/audit/verify', {
      identity,
      query: { fromSeq: query.fromSeq, toSeq: query.toSeq },
    });
    return {
      valid: raw.valid,
      checkedEntries: raw.checked,
      brokenAtSeq: raw.brokenAtSeq ?? null,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Mapa actorId→identidad del STAFF (roster de operadores identity) para enriquecer al actor de cada entrada.
   * UNA lectura REST por página (anti-N+1); el rol primario = `roles[0]` (crudo AdminRole; el front lo traduce).
   * fail-safe: si el roster cae → mapa vacío (la vista degrada a solo-id honesto). Solo se consulta si hay algún
   * actorId real (un set de puras entradas de sistema no dispara la lectura).
   */
  private async actorDirectory(
    identity: AuthenticatedUser,
    entries: AuditEntryResponse[],
  ): Promise<Map<string, ActorIdentity>> {
    const hasActor = entries.some((e) => e.actorId);
    if (!hasActor) return new Map();
    const ops = await this.identityRest
      .get<OperatorRow[]>('/admin/operators', { identity })
      .catch(() => [] as OperatorRow[]);
    const map = new Map<string, ActorIdentity>();
    for (const o of ops) {
      map.set(o.id, { name: o.name || null, role: o.roles?.[0] ?? null });
    }
    return map;
  }
}

export function toAuditEntryView(e: AuditEntryResponse, who?: ActorIdentity): AuditEntryView {
  return {
    id: e.id,
    seq: e.seq,
    actorId: e.actorId ?? null,
    // Nombre/rol del actor enriquecidos on-read (roster de operadores); null si no es staff / no resolvió → la UI
    // cae al actorId (honesto, nunca inventado).
    actorName: who?.name ?? null,
    actorRole: who?.role ?? null,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    at: e.occurredAt,
  };
}

/** Escapa un campo CSV (RFC 4180): comillas dobladas + envoltura si contiene coma/comilla/salto de línea. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Arma el CSV del export de auditoría. Columnas = la fila enriquecida del panel: seq, fecha, acción, recurso
 * (tipo + id), actor (id + nombre + rol resueltos del roster; vacío si no es staff). Header en español. CRLF
 * (RFC 4180) para que Excel/Sheets no fusionen líneas.
 */
function buildAuditCsv(
  entries: AuditEntryResponse[],
  directory: Map<string, ActorIdentity>,
): string {
  const header = [
    'seq',
    'fecha',
    'accion',
    'recursoTipo',
    'recursoId',
    'actorId',
    'actorNombre',
    'actorRol',
  ];
  const lines = entries.map((e) => {
    const who = e.actorId ? directory.get(e.actorId) : undefined;
    return [
      e.seq,
      e.occurredAt,
      e.action,
      e.resourceType,
      e.resourceId,
      e.actorId ?? '',
      who?.name ?? '',
      who?.role ?? '',
    ]
      .map((f) => csvField(f))
      .join(',');
  });
  return [header.map(csvField).join(','), ...lines].join('\r\n');
}
