import { AlertTriangle, Inbox, Lock, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Estado vacío para listas/tablas/mapas sin datos. */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-lg bg-surface-2 text-ink-muted">
        {icon ?? <Inbox className="size-6" aria-hidden />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

/** Estado de error con reintento. */
export function ErrorState({
  title = 'No se pudieron cargar los datos',
  description = 'Hubo un problema al consultar el servidor. Intenta de nuevo.',
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-lg bg-danger/10 text-danger">
        <AlertTriangle className="size-6" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden />
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}

interface PermissionStateProps {
  /** Nombre humano de la sección (ej. "Viajes") — completa "Sin permiso para {section}". */
  section: string;
  /** Slug REAL del permiso que exige la pantalla (ej. "ops:trips:read"). Se muestra verbatim. */
  permission: string;
  onRequest?: () => void;
  className?: string;
}

/**
 * Estado 403 fiel al board (B2v7uK): el overlay de permisos (ADR-025) OCULTA la sección para este operador.
 * NO es un error del server — el par (rol, permiso) está restado por el overlay. Tono ÁMBAR (no rojo): es un
 * candado de gobierno, no una falla. Muestra el slug exacto para que el operador sepa qué pedirle a un admin.
 */
export function PermissionState({
  section,
  permission,
  onRequest,
  className,
}: PermissionStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="grid size-16 place-items-center rounded-full bg-warn/10 text-warn">
        <Lock className="size-[30px]" aria-hidden />
      </div>
      <div className="max-w-[320px] space-y-1.5">
        <p className="font-display text-[19px] font-semibold tracking-[-0.3px] text-ink">
          Sin permiso para {section}
        </p>
        <p className="text-sm leading-relaxed text-ink-muted">
          <span className="font-mono text-[13px]">{permission}</span> está oculto por el overlay.
        </p>
      </div>
      {onRequest ? (
        <button
          type="button"
          onClick={onRequest}
          className="rounded-control bg-warn px-5 py-3 text-[15px] font-semibold text-warn-on shadow-brand transition-opacity hover:opacity-90"
        >
          Solicitar acceso
        </button>
      ) : null}
    </div>
  );
}
