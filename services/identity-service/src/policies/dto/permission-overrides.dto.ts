import { IsBoolean, IsString } from 'class-validator';

/**
 * Body del PUT /internal/permission-overrides. Un override subtract-only sobre el par (role, permission).
 * class-validator solo asegura los TIPOS (strings + boolean); la validación de DOMINIO (rol/permiso canónicos,
 * invariante subtract-only contra la matriz base, candado legal-mandatory) la hace PermissionOverridesService
 * con `@veo/policy` — fuente única de la matriz base (ADR-025 §1/§3).
 */
export class SetPermissionOverrideDto {
  /** Rol afectado (un `AdminRole`). Validado como canónico en el service. */
  @IsString()
  role!: string;

  /** Permiso a restar/des-restaurar (ej. 'drivers:approve'). Validado contra `PERMISSION_ROLES` en el service. */
  @IsString()
  permission!: string;

  /** subtract-only: true = RESTAR al rol; false = des-restaurar (rige la base). */
  @IsBoolean()
  hidden!: boolean;
}
