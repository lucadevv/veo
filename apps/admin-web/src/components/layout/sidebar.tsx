'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { NAV } from './nav';

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const user = useSession();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center gap-3 border-b border-border px-5">
        <div className="grid size-9 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/25">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div className="leading-tight">
          <p className="font-mono text-[15px] font-bold tracking-tight text-ink">VEO</p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-ink-subtle">
            Control de operación
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-7 overflow-y-auto px-3 py-5" aria-label="Navegación principal">
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
    </aside>
  );
}
