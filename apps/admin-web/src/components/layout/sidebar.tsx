'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu, MonitorSmartphone, Moon, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { useTheme } from '@/lib/theme';
import { can } from '@/lib/rbac';
import { logout, logoutAll } from '@/lib/api/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Avatar } from '@/components/ui/avatar';
import { ConnectionStatus } from '@/components/ops/connection-status';
import { NAV } from './nav';

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Rol principal formateado (SUPERADMIN → "Superadmin"). Stopgap honesto: el email no viaja en la sesión. */
function primaryRoleLabel(roles: readonly string[]): string {
  const first = roles[0];
  if (!first) return 'Operador';
  return first
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Sidebar autoritativo del panel — ÚNICA barra de navegación (el diseño no tiene topbar). Lleva, de arriba a
 * abajo: workspace (logo + estado de la conexión de tiempo real /ops), búsqueda global, la navegación agrupada
 * (RBAC), y el pie de usuario (rol + tema + logout). En pantallas chicas se abre como drawer con el botón menú.
 */
export function Sidebar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Desktop: aside fijo */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <SidebarContent />
      </aside>

      {/* Mobile: botón menú flotante + drawer */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir navegación"
        className="fixed left-3 top-3 z-40 grid size-10 place-items-center rounded-lg border border-border bg-surface text-ink shadow-sm lg:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r border-border bg-surface">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Cerrar navegación"
              className="absolute right-2 top-3 grid size-9 place-items-center rounded-lg text-ink-muted hover:bg-surface-2"
            >
              <X className="size-5" aria-hidden />
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}
    </>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useSession();
  const { theme, toggle } = useTheme();
  const [query, setQuery] = useState('');

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      router.push(`/ops/trips?q=${encodeURIComponent(q)}`);
      onNavigate?.();
    }
  }

  async function onLogout() {
    await logout();
    router.replace('/login');
    router.refresh();
  }

  async function onLogoutAll() {
    await logoutAll();
    router.replace('/login');
    router.refresh();
  }

  return (
    <>
      {/* Workspace */}
      <div className="flex h-16 items-center gap-3 border-b border-border px-5">
        <div className="grid size-9 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/25">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="font-mono text-[15px] font-bold tracking-tight text-ink">VEO</p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-ink-subtle">
            Panel de operación
          </p>
        </div>
        {/* Estado de la conexión de tiempo real /ops — global: un admin en CUALQUIER página ve si el
            monitor de pánico perdió conexión. */}
        <ConnectionStatus />
      </div>

      {/* Búsqueda global */}
      <form onSubmit={onSearch} className="relative px-3 py-3">
        <Search
          className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar viaje, conductor o ID…"
          aria-label="Búsqueda global"
          className="w-full rounded-md border border-border bg-bg py-2 pl-9 pr-3 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
        />
      </form>

      {/* Navegación */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4" aria-label="Navegación principal">
        {NAV.map((group) => {
          const items = group.items.filter((item) => can(user, item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.title}>
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-subtle">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active = isActive(pathname, item.href, item.exact);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150',
                          active
                            ? 'bg-surface-2 font-semibold text-ink ring-1 ring-inset ring-white/[0.06]'
                            : 'font-medium text-ink-muted hover:bg-surface-2/60 hover:text-ink',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-4 shrink-0 transition-colors',
                            active ? 'text-accent' : 'text-ink-subtle group-hover:text-ink-muted',
                          )}
                          aria-hidden
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Pie de usuario: rol + MFA + tema + logout */}
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Avatar name={primaryRoleLabel(user.roles)} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-ink">
            {primaryRoleLabel(user.roles)}
          </span>
          <span
            className={cn(
              'truncate text-[11px]',
              user.mfaFresh ? 'text-success' : 'text-ink-subtle',
            )}
          >
            {user.mfaFresh ? 'MFA fresco' : 'MFA inactivo'}
          </span>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          className="grid size-8 place-items-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {theme === 'dark' ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </button>
        {/* Cerrar sesión en TODOS los dispositivos: acción sensible (revoca todas las sesiones) → confirmación. */}
        <ConfirmDialog
          trigger={
            <button
              type="button"
              aria-label="Cerrar sesión en todos los dispositivos"
              className="grid size-8 place-items-center rounded-md text-ink-subtle transition-colors hover:bg-danger/15 hover:text-danger"
            >
              <MonitorSmartphone className="size-4" aria-hidden />
            </button>
          }
          title="Cerrar sesión en todos los dispositivos"
          description="Se cerrará tu sesión en TODOS los dispositivos donde tengas la sesión abierta, no solo en este. Tendrás que volver a iniciar sesión en cada uno."
          confirmLabel="Cerrar en todos"
          variant="danger"
          onConfirm={onLogoutAll}
        />
        <button
          type="button"
          onClick={() => void onLogout()}
          aria-label="Cerrar sesión"
          className="grid size-8 place-items-center rounded-md text-ink-subtle transition-colors hover:bg-danger/15 hover:text-danger"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </>
  );
}
