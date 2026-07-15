/**
 * `@Permission(permission)` — mapea un handler admin a SU permiso canónico (ADR-025 §3/§6/§7 · Fase 1).
 *
 * Los `@Roles(...)` de un controller declaran la CAPA 1 (base: qué rol puede). Para que el OVERLAY (capa 2 ·
 * subtract-only) BLOQUEE server-side por PERMISO — no solo oculte en el front — cada endpoint debe declarar a
 * qué permiso fino mapea (ej. `@Permission('drivers:approve')`). El `PermissionOverlayGuard` (global) lee esta
 * metadata y computa el EFECTIVO `base ∧ ¬override`: si el par (rol, permiso) fue RESTADO por el superadmin,
 * responde 403 aunque el `@Roles` base lo permitiera.
 *
 * El `permission` se tipa como el unión `Permission` de `@veo/policy` (la matriz base `PERMISSION_ROLES`, fuente
 * única) para que el mapeo no pueda divergir del catálogo: un id inexistente no compila.
 *
 * ALCANCE (honesto · ADR-025 §6/§7): en la Ola A NINGÚN endpoint declara `@Permission` todavía → el guard es
 * no-op (sin permiso mapeado no hay overlay que aplicar). El barrido endpoint→permiso es la Ola B; recién ahí
 * el overlay empieza a bloquear donde se declaró.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Permission as PermissionId } from '@veo/policy';

/** Metadata key que lee el `PermissionOverlayGuard`. */
export const PERMISSION_KEY = 'veo:permission';

/** Marca un handler (o controller) con SU permiso canónico para el enforcement del overlay. */
export const Permission = (permission: PermissionId): CustomDecorator<string> =>
  SetMetadata(PERMISSION_KEY, permission);
