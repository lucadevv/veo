/**
 * GobiernoService — proxy del registro PBAC (Gobierno → Políticas · ADR-024 §6) hacia identity-service vía
 * REST interno firmado (InternalRestClient). El BFF propaga la identidad `admin` autenticada por JWT firmando
 * HMAC + audiencia `admin-rail` (NUNCA el JWT crudo) → identity la verifica con InternalIdentityGuard +
 * AudienceGuard(ADMIN_RAIL) sobre `/internal/policies`. El RBAC fino (SUPERADMIN) + el step-up MFA los aplica
 * el controller en el BORDE (Ola 3); identity es el STORAGE (valida params contra @veo/policy, bumpea version,
 * emite policy.updated + audit WORM). La mutación se audita también acá (acción del operador · Ley 29733),
 * espejo de DispatchConfigService/FinanceService. Los errores del downstream (400 validación Zod, 403
 * mandatory, 404 política inexistente) los propaga InternalRestClient como DownstreamError con su status +
 * message → el filtro global del BFF los reemite tal cual para que la UI los vea.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_IDENTITY } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { UpdatePolicyDto } from './dto/update-policy.dto';
import type { SetPermissionOverrideDto } from './dto/set-permission-override.dto';

/**
 * Vista de una política que devuelven los endpoints internos de identity (espeja `PolicyView` de
 * identity-service · row + `params` como objeto plano). Se re-declara acá (contrato del wire) para no acoplar
 * el BFF al import del service de otro bounded-context — igual criterio que `RadiusConfigView` en dispatch.
 */
export interface PolicyView {
  key: string;
  family: string;
  enabled: boolean;
  params: Record<string, unknown>;
  mandatory: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Una entrada del HISTORIAL de una política (timeline del detalle · Gobierno → Políticas). Espeja el
 * `PolicyVersionView` del wire de identity (snapshot de una versión). Re-declarada acá (contrato del wire) para
 * no acoplar el BFF al import del service de otro bounded-context — igual criterio que `PolicyView`.
 */
export interface PolicyVersionView {
  version: number;
  enabled: boolean;
  params: Record<string, unknown>;
  changedBy: string;
  changedAt: string;
}

/**
 * Vista de un override de visibilidad de permisos que devuelve el endpoint interno de identity (espeja
 * `PermissionOverrideView` · row proyectado, `updatedAt` como ISO). Re-declarada acá (contrato del wire) para
 * no acoplar el BFF al import del service de otro bounded-context — igual criterio que `PolicyView`.
 */
export interface PermissionOverrideView {
  role: string;
  permission: string;
  hidden: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

const BASE = '/internal/policies';
const OVERRIDES_BASE = '/internal/permission-overrides';

/** Acción/recurso de audit de la mutación (const tipadas, NUNCA strings sueltos). */
const AUDIT_ACTION = 'policy.update' as const;
const AUDIT_RESOURCE_TYPE = 'policy' as const;

/** Acción/recurso de audit de la mutación del overlay de permisos (ADR-025 §3). */
const AUDIT_OVERRIDE_ACTION = 'permission_override.update' as const;
const AUDIT_OVERRIDE_RESOURCE_TYPE = 'permission_override' as const;

@Injectable()
export class GobiernoService {
  constructor(
    @Inject(REST_IDENTITY) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** Todas las políticas de gobierno vigentes (la grilla). identity gatea la identidad interna admin-rail. */
  list(identity: AuthenticatedUser): Promise<PolicyView[]> {
    return this.rest.get<PolicyView[]>(BASE, { identity });
  }

  /** Una política por su key (404 si la política no existe/no está seedeada · 400 si la key es desconocida). */
  get(identity: AuthenticatedUser, key: string): Promise<PolicyView> {
    return this.rest.get<PolicyView>(`${BASE}/${encodeURIComponent(key)}`, { identity });
  }

  /**
   * Historial de cambios de una política (timeline del detalle · más reciente primero). Lectura pura: identity
   * devuelve `[]` si la política es válida pero aún no tiene cambios (400 si la key es desconocida). Sin audit
   * de acceso (es config de gobierno visible solo a SUPERADMIN, no PII).
   */
  history(identity: AuthenticatedUser, key: string): Promise<PolicyVersionView[]> {
    return this.rest.get<PolicyVersionView[]>(
      `${BASE}/${encodeURIComponent(key)}/history`,
      { identity },
    );
  }

  /**
   * Aplica el parche {enabled?, params?} a una política. identity VALIDA params (Zod), aplica el candado
   * `mandatory`, bumpea `version` y emite policy.updated en la misma tx. Acá se audita la acción del operador.
   */
  async update(
    identity: AuthenticatedUser,
    key: string,
    dto: UpdatePolicyDto,
  ): Promise<PolicyView> {
    const res = await this.rest.put<PolicyView>(`${BASE}/${encodeURIComponent(key)}`, {
      identity,
      body: { enabled: dto.enabled, params: dto.params, expectedVersion: dto.expectedVersion },
    });
    await this.audit.record(identity, {
      action: AUDIT_ACTION,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: res.key,
      payload: { enabled: res.enabled, version: res.version, params: res.params },
    });
    return res;
  }

  // ── OVERLAY de visibilidad de permisos (Gobierno → Permisos · ADR-025 §3) ─────────────────────────────
  // Segunda capa del gobierno unificado: mismo molde que las políticas (proxy REST admin-rail firmado hacia
  // identity, el STORAGE). identity VALIDA en profundidad (subtract-only + candado legal-mandatory); el borde
  // autoriza (SUPERADMIN + step-up en el PUT) y audita la acción del operador.

  /** Todos los pares (rol, permiso) RESTADOS vigentes (la grilla del overlay). Ausencia de fila = rige la base. */
  listOverrides(identity: AuthenticatedUser): Promise<PermissionOverrideView[]> {
    return this.rest.get<PermissionOverrideView[]>(OVERRIDES_BASE, { identity });
  }

  /**
   * Aplica {role, permission, hidden} al overlay: reenvía a identity, que valida el invariante subtract-only
   * (400 si el par no es base) y el candado legal-mandatory (403 si se intenta restar audit/finance sensibles),
   * bumpea version + emite permission_override.updated. Acá se audita la acción del operador (Ley 29733).
   */
  async setOverride(
    identity: AuthenticatedUser,
    dto: SetPermissionOverrideDto,
  ): Promise<PermissionOverrideView> {
    const res = await this.rest.put<PermissionOverrideView>(OVERRIDES_BASE, {
      identity,
      body: { role: dto.role, permission: dto.permission, hidden: dto.hidden },
    });
    await this.audit.record(identity, {
      action: AUDIT_OVERRIDE_ACTION,
      resourceType: AUDIT_OVERRIDE_RESOURCE_TYPE,
      resourceId: `${res.role}|${res.permission}`,
      payload: { hidden: res.hidden, version: res.version },
    });
    return res;
  }
}
