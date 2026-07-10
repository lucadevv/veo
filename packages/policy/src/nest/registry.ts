/**
 * Puerto + adapter de lectura del REGISTRO central de políticas (identity-service · ADR-024 §2).
 *
 * `PolicyRegistryPort` es la costura testeable: el `KafkaCachedPolicyReader` depende de este puerto (no del
 * `InternalRestClient` pesado), así los tests le pasan un doble en memoria. `InternalRestPolicyRegistry` es
 * el adapter real: llama `GET /internal/policies` firmando una identidad de SISTEMA como `admin-rail` (el
 * endpoint está gated con InternalIdentityGuard + AudienceGuard(ADMIN_RAIL)) vía `InternalRestClient` (HMAC).
 */
import { InternalRestClient } from '@veo/rpc';
import { anonymousIdentity, type AuthenticatedUser } from '@veo/auth';
import type { PolicyParams } from '../catalog.js';

/**
 * Vista de una política tal como la expone `GET /internal/policies` de identity-service (contrato del wire).
 * Se re-declara acá (no se importa de identity-service) para no acoplar este paquete a otro bounded-context —
 * mismo criterio que `PolicyView` en el admin-bff. Solo se consumen `key/enabled/params/version` en el cache.
 */
export interface PolicyView {
  key: string;
  family: string;
  enabled: boolean;
  params: PolicyParams;
  mandatory: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Vista de un override de permiso tal como lo expondrá `GET /internal/permission-overlays` de
 * identity-service en la Ola 2 (contrato del wire · ADR-025 §3). Re-declarada acá (no importada del otro
 * bounded-context) por el mismo criterio que `PolicyView`. El cache solo consume `role/permission/hidden/version`.
 * Subtract-only: el registro guarda SOLO los pares restados; ausencia = comportamiento base.
 */
export interface PermissionOverrideView {
  role: string;
  permission: string;
  hidden: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** Puerto de lectura del registro central de gobierno. Un doble en tests, el REST interno en prod. */
export interface PolicyRegistryPort {
  /** Todas las políticas vigentes (la grilla de gobierno). Lanza si el registro es inalcanzable. */
  list(): Promise<PolicyView[]>;
  /**
   * Todos los overrides de permiso vigentes (overlay, capa 2 · ADR-025). Lanza si el registro es inalcanzable
   * o si el endpoint aún no existe (Ola 2): el reader TOLERA el fallo → overlay vacío = sin overrides (fail-safe).
   */
  listOverrides(): Promise<PermissionOverrideView[]>;
}

/** Endpoints internos del registro de gobierno (idénticos a los que consume el admin-bff). */
const POLICIES_PATH = '/internal/policies';
const OVERRIDES_PATH = '/internal/permission-overrides';

/**
 * Adapter REST interno firmado (HMAC · riel admin) sobre `InternalRestClient`. No hay usuario final detrás de
 * la carga inicial de un servicio de enforcement → se firma una identidad de SISTEMA anónima (`anonymousIdentity`)
 * con el riel del cliente (admin-rail). El endpoint solo verifica firma + audiencia (el RBAC fino es del borde).
 */
export class InternalRestPolicyRegistry implements PolicyRegistryPort {
  /** Identidad de sistema (sin sesión real) que se firma en cada request; el riel lo fija el propio cliente. */
  private readonly identity: AuthenticatedUser = anonymousIdentity('admin');

  constructor(private readonly rest: InternalRestClient) {}

  list(): Promise<PolicyView[]> {
    return this.rest.get<PolicyView[]>(POLICIES_PATH, { identity: this.identity });
  }

  listOverrides(): Promise<PermissionOverrideView[]> {
    return this.rest.get<PermissionOverrideView[]>(OVERRIDES_PATH, { identity: this.identity });
  }
}
