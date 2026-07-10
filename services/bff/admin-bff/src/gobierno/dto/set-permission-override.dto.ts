import { IsBoolean, IsString } from 'class-validator';

/**
 * Body del PUT /gobierno/permission-overrides (OVERLAY de visibilidad de permisos · ADR-025 §3). Un override
 * SUBTRACT-ONLY sobre el par (role, permission). Espeja el SetPermissionOverrideDto interno de identity-service:
 * class-validator solo asegura los TIPOS del wire (strings + boolean); la validación de DOMINIO (rol/permiso
 * canónicos, invariante subtract-only contra la matriz base, candado legal-mandatory) la hace identity-service
 * con `@veo/policy` — fuente ÚNICA de la matriz base. Acá NO se re-valida (no se duplica el schema): el borde
 * solo autoriza (RBAC SUPERADMIN + step-up) y reenvía; identity es el storage.
 */
export class SetPermissionOverrideDto {
  /** Rol afectado (un `AdminRole`). identity lo valida como canónico (400 si desconocido). */
  @IsString()
  role!: string;

  /** Permiso a restar/des-restaurar (ej. 'drivers:approve'). identity lo valida contra el catálogo (400 si desconocido). */
  @IsString()
  permission!: string;

  /** subtract-only: true = RESTAR al rol; false = des-restaurar (rige la base). */
  @IsBoolean()
  hidden!: boolean;
}
