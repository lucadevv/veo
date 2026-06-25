'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu, Moon, Search, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { logout } from '@/lib/api/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConnectionStatus } from '@/components/ops/connection-status';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { NAV } from './nav';

/** Formatea el rol principal del operador para el topbar (SUPERADMIN → "Superadmin", SUPPORT_L1 → "Support L1").
 *  Stopgap honesto mientras el email no viaja en la sesión — mostrar el UUID es un wart de UX. */
function primaryRoleLabel(roles: readonly string[]): string {
  const first = roles[0];
  if (!first) return 'Operador';
  return first
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export function Topbar() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const user = useSession();
  const [query, setQuery] = useState('');

  async function onLogout() {
    await logout();
    router.replace('/login');
    router.refresh();
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) router.push(`/ops/trips?q=${encodeURIComponent(q)}`);
  }

  return (
    <header className="sticky top-0 z-sticky flex h-16 items-center gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur lg:px-6">
      <MobileNav />

      <form onSubmit={onSearch} className="relative hidden max-w-md flex-1 sm:block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Buscar viaje, conductor o ID…"
          aria-label="Búsqueda global"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </form>

      <div className="ml-auto flex items-center gap-2">
        {/* Estado de la conexión de tiempo real /ops — global: un admin en CUALQUIER página ve
            si el monitor de pánico perdió conexión, no solo en /ops. */}
        <ConnectionStatus />

        <Badge tone={user.mfaFresh ? 'success' : 'neutral'}>
          <ShieldCheck className="size-3.5" aria-hidden />
          {user.mfaFresh ? 'MFA fresco' : 'MFA inactivo'}
        </Badge>

        <Button
          variant="ghost"
          size="sm"
          aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          onClick={toggle}
          className="size-9 px-0"
        >
          {theme === 'dark' ? (
            <Sun className="size-5" aria-hidden />
          ) : (
            <Moon className="size-5" aria-hidden />
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="gap-2">
              <span className="grid size-5 place-items-center rounded-full bg-accent/15 text-accent">
                <UserRound className="size-3.5" aria-hidden />
              </span>
              <span className="hidden max-w-40 truncate sm:inline">{primaryRoleLabel(user.roles)}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="px-2.5 py-2 text-xs text-ink-muted">
              {user.roles.join(', ') || 'Sin roles'}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void onLogout();
              }}
            >
              <LogOut className="size-4" aria-hidden />
              Cerrar sesión
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function MobileNav() {
  const pathname = usePathname();
  const user = useSession();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="size-9 px-0 lg:hidden" aria-label="Abrir menú">
          <Menu className="size-5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="left-0 top-0 h-full max-w-72 translate-x-0 translate-y-0 rounded-none rounded-r-lg">
        <DialogTitle className="mb-4">Navegación</DialogTitle>
        <nav className="space-y-5">
          {NAV.map((group) => {
            const items = group.items.filter((item) => can(user, item.permission));
            if (items.length === 0) return null;
            return (
              <div key={group.title}>
                <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                  {group.title}
                </p>
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const active = item.exact
                      ? pathname === item.href
                      : pathname.startsWith(item.href);
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setOpen(false)}
                          className={cn(
                            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                            active
                              ? 'bg-accent/10 text-accent'
                              : 'text-ink-muted hover:bg-surface-2',
                          )}
                        >
                          <Icon className="size-4" aria-hidden />
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
      </DialogContent>
    </Dialog>
  );
}
