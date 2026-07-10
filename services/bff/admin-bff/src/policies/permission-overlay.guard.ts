/**
 * PermissionOverlayGuard — enforcement server-side del OVERLAY de visibilidad (ADR-025 §3/§6/§7 · Fase 1).
 *
 * La CAPA 2 del gobierno unificado: el superadmin RESTA (subtract-only) un permiso a un rol vía el registro
 * `PermissionOverride`. Este guard es el "bloquear, no solo ocultar" del ADR: el front oculta el botón/nav
 * (compone `base ∧ ¬override`), pero la AUTORIDAD es el server (defensa en profundidad).
 *
 * POSICIÓN EN LA CADENA: corre DESPUÉS del `RolesGuard`. El `@Roles` base ya validó que el rol del actor está
 * permitido (capa 1); este guard solo REFINA restando — nunca concede. Por eso el overlay no puede ampliar:
 * `@Roles` sigue siendo el gate primario y esto solo agrega una negación sobre lo que la base ya dio.
 *
 * LÓGICA DEL EFECTIVO (ADR-025 §3):
 *   efectivo(P) = OR sobre los roles del user de ( baseGrants(role, P) AND NOT isPermissionHiddenSync(role, P) )
 *   - `baseGrants(role, P)`      → ¿la matriz base (`@veo/policy` `PERMISSION_ROLES`) le da P a ese rol?
 *   - `isPermissionHiddenSync`   → ¿el overlay RESTÓ P a ese rol? (cache síncrono del `PolicyReaderPort`)
 *   - OR entre roles: un user con 2 roles pasa si AL MENOS uno conserva P (base ∧ ¬override) — el más permisivo.
 *   Si `efectivo === false` → `ForbiddenError` (el overlay restó P para el/los rol(es) del actor).
 *
 * REGLAS (nunca fail-open · ADR-025 §3 fail-safe):
 *   • Handler SIN `@Permission` → ALLOW (no-op). Sin permiso mapeado no hay overlay que aplicar — el gap
 *     honesto documentado (ADR §6): el barrido endpoint→permiso es la Ola B. En la Ola A NADIE declara
 *     `@Permission`, así que el guard es no-op y NO cambia comportamiento.
 *   • `@Public` → ALLOW (ruta abierta, sin actor que refinar).
 *   • Sin `req.user` → ALLOW: no es responsabilidad de este guard autenticar; los guards previos (Jwt/Roles)
 *     ya decidieron. Refinar sin actor no tiene sentido.
 *   • Reader ausente (servicio sin `PolicyModule`, `@Optional`) → NO se resta nada: `hidden` cae al default
 *     `false`, así que `efectivo` = base pura. Como `RolesGuard` ya pasó, la base concede → ALLOW (fail-safe:
 *     un fallo de lectura del overlay NUNCA bloquea; nunca fail-open a conceder de más, tampoco).
 */
import {
  Injectable,
  Inject,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import {
  IS_PUBLIC_KEY,
  POLICY_READER_PORT,
  type PolicyReaderPort,
  type AuthenticatedUser,
} from '@veo/auth';
import { isPermissionEffective } from '@veo/policy';
import { PERMISSION_KEY } from './permission.decorator';

@Injectable()
export class PermissionOverlayGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Puerto síncrono del overlay (mismo token que lee el StepUpMfaGuard). OPCIONAL: si nadie registra
    // `PolicyModule`, no se resta nada (fail-safe: sin overlay = base pura).
    @Optional() @Inject(POLICY_READER_PORT) private readonly policy?: PolicyReaderPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public: ruta abierta, sin actor que refinar.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Permiso mapeado al handler (o heredado del controller). Sin él → no-op (gap honesto · Ola B).
    const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    // Sin actor autenticado → no es asunto de este guard (Jwt/Roles ya decidieron). Refinar sin roles no aplica.
    if (!user) return true;

    // efectivo = OR sobre roles de ( base concede ∧ ¬ overlay restó ) — fórmula compartida con la sesión
    // (`computeHiddenPermissions`) vía `@veo/policy`, para no divergir. Reader ausente → hidden=false (base pura).
    const effective = isPermissionEffective(
      user.roles,
      permission,
      (role, perm) => this.policy?.isPermissionHiddenSync(role, perm) ?? false,
    );
    if (!effective) {
      throw new ForbiddenError('Permiso restado por el overlay de visibilidad', { permission });
    }
    return true;
  }
}
