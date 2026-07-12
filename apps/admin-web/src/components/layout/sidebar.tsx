'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu, MonitorSmartphone, Moon, Search, Sun, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { useTheme } from '@/lib/theme';
import { can } from '@/lib/rbac';
import { logout, logoutAll } from '@/lib/api/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ConnectionStatus } from '@/components/ops/connection-status';
import { NAV } from './nav';

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Rol principal formateado (SUPERADMIN → "Superadmin"). Stopgap honesto: el email/nombre no viaja en la sesión. */
function primaryRoleLabel(roles: readonly string[]): string {
  const first = roles[0];
  if (!first) return 'Operador';
  return first
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Sidebar autoritativo del panel — ÚNICA barra de navegación (el diseño no tiene topbar). Fiel al
 * T/AdminSidebar de veo.pen: workspace (logo sólido "V" + wordmark + estado realtime), búsqueda global con
 * atajo ⌘K, navegación agrupada (RBAC) con item activo en accent, y pie de usuario. Drawer en pantallas chicas.
 */
export function Sidebar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Desktop: aside fijo */}
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <SidebarContent />
      </aside>

      {/* Mobile: botón menú flotante + drawer */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir navegación"
        className="fixed left-3 top-3 z-40 grid size-10 place-items-center rounded-lg border border-border bg-surface text-ink shadow-1 lg:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 flex h-full w-[260px] flex-col border-r border-border bg-surface">
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
  const searchRef = useRef<HTMLInputElement>(null);

  // Atajo ⌘K / Ctrl+K: enfoca la búsqueda global (respalda el chip ⌘K del diseño con comportamiento real).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const roleLabel = primaryRoleLabel(user.roles);
  const initials = roleLabel.slice(0, 2).toUpperCase();

  return (
    <>
      {/* Workspace */}
      <div className="flex items-center gap-3 border-b border-[color:var(--divider)] px-4 py-4">
        <div className="grid size-[38px] shrink-0 place-items-center rounded-[10px] bg-accent">
          <span className="font-display text-xl font-bold leading-none text-accent-on">V</span>
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="font-display text-[15px] font-bold tracking-tight text-ink">VEO</p>
          <p className="text-xs text-ink-muted">Panel Admin</p>
        </div>
        {/* Estado de la conexión realtime /ops (funcional). Reemplaza el chevron decorativo del diseño:
            en un panel de seguridad, ver si el monitor de pánico perdió conexión pesa más que el afford visual. */}
        <ConnectionStatus />
      </div>

      {/* Búsqueda global con atajo ⌘K */}
      <div className="px-3 py-2.5">
        <form
          onSubmit={onSearch}
          className="flex items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2"
        >
          <Search className="size-[15px] shrink-0 text-ink-subtle" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar…"
            aria-label="Búsqueda global"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
          />
          <kbd className="rounded-[6px] border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-subtle">
            ⌘K
          </kbd>
        </form>
      </div>

      {/* Navegación */}
      <nav className="flex-1 space-y-3 overflow-y-auto px-2.5 pb-4" aria-label="Navegación principal">
        {NAV.map((group) => {
          const items = group.items.filter((item) => can(user, item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.title}>
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-subtle">
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
                          'group flex items-center gap-3 rounded-sm px-2.5 py-2 text-[13px] transition-colors duration-150',
                          active
                            ? 'bg-accent/10 font-semibold text-accent'
                            : 'font-medium text-ink-muted hover:bg-surface-2 hover:text-ink',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-[17px] shrink-0 transition-colors',
                            active ? 'text-accent' : 'text-ink-muted group-hover:text-ink',
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

      {/* Pie de usuario: avatar + rol + MFA + controles (tema · cerrar en todos · salir) */}
      <div className="flex items-center gap-3 border-t border-[color:var(--divider)] px-3.5 py-3">
        <div className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent">
          <span className="text-[13px] font-semibold text-accent-on">{initials}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-ink">{roleLabel}</span>
          <span
            className={cn('truncate text-[11px]', user.mfaFresh ? 'text-success' : 'text-ink-subtle')}
          >
            {user.mfaFresh ? 'MFA fresco' : 'MFA inactivo'}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            className="grid size-8 place-items-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </button>
          {/* Cerrar sesión en TODOS los dispositivos: acción sensible → confirmación. */}
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
      </div>
    </>
  );
}
