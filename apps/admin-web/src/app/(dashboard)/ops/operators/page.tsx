'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useOperators } from '@/lib/api/queries';
import type { Operator } from '@/lib/api/schemas';
import { relativeAccess } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { ROLE_LABELS, ROLE_TONE } from '@/lib/roles';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { useRequestAccess } from '@/lib/use-request-access';
import { OperatorActions } from '@/components/operators/operator-actions';
import { NewOperatorDialog } from '@/components/operators/new-operator-dialog';

const PILL_CLS: Record<string, string> = {
  brand: 'bg-accent/10 text-accent',
  purple: 'bg-[#7C3AED]/10 text-[#7C3AED]',
  success: 'bg-success/10 text-success',
  warn: 'bg-warn/10 text-warn',
  info: 'bg-[#0097CE]/10 text-[#0097CE]',
  neutral: 'bg-bg text-ink-muted',
};

/** Iniciales del nombre (o email) para el avatar. */
function initials(op: Operator): string {
  const label = op.name ?? op.email;
  const parts = label.trim().split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

/** Estado del 2FA por operador: sin login aún (INVITED) → "—"; si no, Sí/Pendiente. */
function twoFa(op: Operator): { label: string; cls: string } {
  if (op.status === 'INVITED') return { label: '—', cls: 'text-ink-subtle' };
  return op.totpEnrolled
    ? { label: 'Sí', cls: 'text-success' }
    : { label: 'Pendiente', cls: 'text-warn' };
}

/**
 * Operadores del panel (staff) — migrado al Trust light, fiel al frame zH2oa. TODO dato REAL de
 * `GET /operators`. Fila → detalle (lB5FS). Alta por invitación con step-up (NewOperatorDialog);
 * reinvite/reject por fila (OperatorActions). Gate 403 fiel al overlay: solo ADMIN/SUPERADMIN.
 */
/** Roles ofrecidos en el filtro (todos los del catálogo RBAC). */
const ROLE_OPTIONS = Object.keys(ROLE_LABELS);

export default function OperatorsPage() {
  const router = useRouter();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const query = useOperators();
  const rows: Operator[] = query.data ?? [];

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');

  // Búsqueda + filtro CLIENT-SIDE: la lista completa de operadores (staff, pocas filas) llega en un GET
  // /operators → filtrar en cliente es honesto (no hay endpoint de búsqueda server, ni hace falta a esta escala).
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((op) => {
        const matchesText =
          !q ||
          (op.name ?? '').toLowerCase().includes(q) ||
          op.email.toLowerCase().includes(q);
        const matchesRole = roleFilter === 'ALL' || op.roles.includes(roleFilter as Operator['roles'][number]);
        return matchesText && matchesRole;
      }),
    [rows, q, roleFilter],
  );

  // Subtítulo con CONTEO real (fiel al frame): total + invitaciones pendientes (status INVITED). Mientras carga,
  // subtítulo descriptivo (no inventa un "0 operadores").
  const pending = rows.filter((op) => op.status === 'INVITED').length;
  const subtitle = query.data
    ? `${rows.length} ${rows.length === 1 ? 'operador' : 'operadores'} del panel · ${pending} ${pending === 1 ? 'invitación pendiente' : 'invitaciones pendientes'}`
    : 'Staff del panel · alta por invitación y gestión de roles';

  const topbar = <AdminTopbar title="Operadores" subtitle={subtitle} />;

  if (!can(user, 'operators:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Operadores"
          permission="operators:view"
          onRequest={() => requestAccess('operators:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto p-7">
        {/* Toolbar: buscar (nombre/correo) + filtro por Rol + alta por invitación (client-side, fiel al frame) */}
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-black/[0.05] bg-surface p-3.5 shadow-3">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2">
            <Search className="size-[17px] shrink-0 text-ink-subtle" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar operador o correo…"
              aria-label="Buscar operadores"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filtrar por rol"
            className="rounded-[11px] border border-border bg-bg px-3 py-[9px] text-sm font-medium text-ink outline-none"
          >
            <option value="ALL">Rol</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          {can(user, 'operators:create') ? <NewOperatorDialog /> : null}
        </div>

        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-black/[0.05] bg-surface shadow-3">
            {/* Header */}
            <div className="flex items-center gap-4 border-b border-[color:var(--divider)] bg-bg px-[22px] py-3 text-[11px] font-bold uppercase tracking-[0.05em] text-ink-subtle">
              <span className="flex-1">Operador</span>
              <span className="hidden w-[200px] shrink-0 md:block">Rol</span>
              <span className="w-[110px] shrink-0">Estado</span>
              <span className="hidden w-[100px] shrink-0 lg:block">2FA</span>
              <span className="hidden w-[140px] shrink-0 xl:block">Último acceso</span>
              <span className="w-10 shrink-0" />
            </div>

            {query.isLoading ? (
              <div className="space-y-px p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                title="Todavía no hay operadores"
                description="Invitá al primer operador del panel."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="Sin resultados"
                description="Ningún operador coincide con la búsqueda o el filtro de rol."
              />
            ) : (
              <ul>
                {filtered.map((op, i) => {
                  const fa = twoFa(op);
                  return (
                    <li
                      key={op.id}
                      onClick={() => router.push(`/ops/operators/${op.id}`)}
                      className={`flex cursor-pointer items-center gap-4 px-[22px] py-3.5 transition-colors hover:bg-surface-2 ${
                        i < filtered.length - 1 ? 'border-b border-[color:var(--divider)]' : ''
                      }`}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2.5">
                        <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent/10 text-[12px] font-semibold text-accent">
                          {initials(op)}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium text-ink">
                            {op.name ?? op.email}
                          </span>
                          <span className="truncate text-xs text-ink-subtle">{op.email}</span>
                        </span>
                      </span>

                      <span className="hidden w-[200px] shrink-0 md:block">
                        {op.roles.length > 0 ? (
                          <span className="flex flex-wrap gap-1.5">
                            {op.roles.map((role) => (
                              <span
                                key={role}
                                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  PILL_CLS[ROLE_TONE[role] ?? 'neutral']
                                }`}
                              >
                                {ROLE_LABELS[role] ?? role}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-subtle">—</span>
                        )}
                      </span>

                      <span className="w-[110px] shrink-0">
                        <StatusPill status={op.status} />
                      </span>

                      <span className={`hidden w-[100px] shrink-0 text-[13px] font-medium lg:block ${fa.cls}`}>
                        {fa.label}
                      </span>

                      <span className="hidden w-[140px] shrink-0 text-[13px] text-ink-muted xl:block">
                        {relativeAccess(op.lastLoginAt)}
                      </span>

                      {/* Acciones rápidas (reinvite/reject) — no navegan al detalle. */}
                      <span
                        className="flex w-10 shrink-0 justify-end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <OperatorActions operator={op} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
