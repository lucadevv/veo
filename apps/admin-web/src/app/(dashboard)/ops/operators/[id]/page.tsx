'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArchiveX, Ban, Check, LogOut, ShieldCheck } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import {
  useOperatorDetail,
  useRemoveOperator,
  useRevokeOperatorSession,
  useSuspendOperator,
} from '@/lib/api/queries';
import { dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { ROLE_LABELS, ROLE_TONE, PERMISSION_LABELS } from '@/lib/roles';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { useRequestAccess } from '@/lib/use-request-access';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { ChangeRoleDialog } from '@/components/operators/change-role-dialog';

/** Iniciales (2) de un nombre/email para el avatar. */
function initials(label: string): string {
  const parts = label.trim().split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

/** Detalle de operador fiel al frame lB5FS: identidad + permisos efectivos (izq) · rol + sesiones + acciones (der). */
export default function OperatorDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const router = useRouter();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const { toast } = useToast();
  const query = useOperatorDetail(id);
  const op = query.data;

  const suspend = useSuspendOperator();
  const remove = useRemoveOperator();
  const revoke = useRevokeOperatorSession();

  const canManage = can(user, 'operators:create');
  const displayName = op?.name ?? op?.email ?? '';

  const topbar = (
    <AdminTopbar
      title={op ? displayName : `Operador #${id.slice(0, 8)}`}
      breadcrumb={
        <span className="flex items-center gap-1.5">
          <Link href="/ops/operators" className="transition-colors hover:text-ink">
            Operadores
          </Link>
          <span className="text-ink-subtle">/</span>
          <span className="text-ink-muted">{op ? displayName : `#${id.slice(0, 8)}`}</span>
        </span>
      }
      actions={op ? <StatusPill status={op.status} /> : null}
    />
  );

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

      {query.isLoading ? (
        <div className="grid gap-[18px] p-7 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-[420px] rounded-[20px]" />
          <Skeleton className="h-[420px] rounded-[20px]" />
        </div>
      ) : query.isError ? (
        query.error instanceof ApiError && query.error.status === 404 ? (
          <EmptyState
            className="m-7"
            icon={<ArchiveX className="size-6" aria-hidden />}
            title="Operador no disponible"
            description="Este operador ya no está en el panel."
          />
        ) : (
          <ErrorState onRetry={() => void query.refetch()} className="m-7" />
        )
      ) : op ? (
        <div className="grid flex-1 gap-[18px] overflow-y-auto p-7 lg:grid-cols-[1fr_360px] lg:items-start">
          {/* Columna izquierda: identidad + permisos efectivos */}
          <div className="flex flex-col gap-[18px]">
            <Card>
              <div className="flex items-center gap-3.5">
                <span
                  className="grid size-14 shrink-0 place-items-center rounded-full font-display text-lg font-bold text-white"
                  style={{ backgroundImage: 'linear-gradient(-135deg, var(--accent), #4A9BC7)' }}
                >
                  {initials(displayName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-display text-xl font-bold text-ink">{displayName}</p>
                  <p className="truncate text-[13px] text-ink-muted">
                    {op.email} · Miembro desde {dateTime(op.createdAt)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {op.roles.map((role) => (
                  <RolePill key={role} role={role} />
                ))}
                <Pill
                  tone={op.totpEnrolled ? 'success' : 'warn'}
                  label={op.totpEnrolled ? '2FA activo' : 'Sin 2FA'}
                />
              </div>
              <p className="text-xs text-ink-subtle">
                Último acceso: {op.lastLoginAt ? dateTime(op.lastLoginAt) : 'nunca'}
              </p>
            </Card>

            <Card>
              <h2 className="font-display text-base font-semibold text-ink">Permisos efectivos</h2>
              {op.effectivePermissions.length === 0 ? (
                <p className="text-sm text-ink-muted">Sin permisos efectivos.</p>
              ) : (
                <ul className="flex flex-col">
                  {op.effectivePermissions.map((perm, i) => (
                    <li
                      key={perm}
                      className={`flex items-center gap-3 py-2.5 ${
                        i < op.effectivePermissions.length - 1 ? 'border-b border-divider' : ''
                      }`}
                    >
                      <Check className="size-[15px] shrink-0 text-success" aria-hidden />
                      <span className="font-mono text-[13px] font-medium text-ink">{perm}</span>
                      <span className="ml-auto text-xs text-ink-subtle">
                        {PERMISSION_LABELS[perm] ?? ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Columna derecha: rol + sesiones + acciones */}
          <div className="flex flex-col gap-[18px]">
            <Card>
              <h2 className="font-display text-base font-semibold text-ink">Rol</h2>
              <div className="flex flex-wrap gap-2">
                {op.roles.map((role) => (
                  <RolePill key={role} role={role} />
                ))}
              </div>
              {canManage ? (
                <ChangeRoleDialog
                  operatorId={op.id}
                  currentRoles={op.roles}
                  trigger={
                    <button
                      type="button"
                      className="w-full rounded-control border border-border bg-bg px-4 py-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
                    >
                      Cambiar rol
                    </button>
                  }
                />
              ) : null}
            </Card>

            <Card>
              <h2 className="font-display text-base font-semibold text-ink">Sesiones activas</h2>
              {op.sessions.length === 0 ? (
                <p className="text-sm text-ink-muted">Sin sesiones activas.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {op.sessions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">
                          Sesión {s.id.slice(0, 8)}
                        </p>
                        <p className="text-xs text-ink-subtle">Activa {dateTime(s.lastActiveAt)}</p>
                      </div>
                      {canManage ? (
                        <StepUpDialog
                          title="Revocar sesión"
                          description="La sesión se cerrará de inmediato. El operador tendrá que iniciar sesión de nuevo."
                          confirmLabel="Revocar"
                          confirmVariant="danger"
                          icon={LogOut}
                          onVerified={async () => {
                            await revoke.mutateAsync({ id: op.id, sessionId: s.id });
                            toast({ tone: 'success', title: 'Sesión revocada' });
                          }}
                          trigger={
                            <button
                              type="button"
                              className="shrink-0 rounded-[9px] border border-border bg-bg px-3 py-1.5 text-[13px] font-semibold text-ink-muted transition-colors hover:bg-surface-2"
                            >
                              Revocar
                            </button>
                          }
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {canManage ? (
              <div className="flex flex-col gap-2.5">
                {op.status === 'ACTIVE' ? (
                  <StepUpDialog
                    title="Suspender operador"
                    description="El operador no podrá ingresar al panel hasta ser reactivado. Sus sesiones se cierran."
                    confirmLabel="Suspender"
                    confirmVariant="danger"
                    icon={Ban}
                    onVerified={async () => {
                      await suspend.mutateAsync({ id: op.id });
                      toast({ tone: 'success', title: 'Operador suspendido' });
                    }}
                    trigger={
                      <button
                        type="button"
                        className="flex items-center justify-center gap-2 rounded-control border border-warn bg-surface px-4 py-3 text-sm font-semibold text-warn transition-colors hover:bg-warn/5"
                      >
                        <Ban className="size-4" aria-hidden />
                        Suspender operador
                      </button>
                    }
                  />
                ) : null}
                <StepUpDialog
                  title="Remover del panel"
                  description="Se quita al operador del panel (acción reversible por un admin). Sus sesiones se cierran."
                  confirmLabel="Remover"
                  confirmVariant="danger"
                  icon={ArchiveX}
                  onVerified={async () => {
                    await remove.mutateAsync({ id: op.id });
                    toast({ tone: 'success', title: 'Operador removido' });
                    router.push('/ops/operators');
                  }}
                  trigger={
                    <button
                      type="button"
                      className="flex items-center justify-center gap-2 rounded-control border border-danger bg-surface px-4 py-3 text-sm font-semibold text-danger transition-colors hover:bg-danger/5"
                    >
                      <ArchiveX className="size-4" aria-hidden />
                      Remover del panel
                    </button>
                  }
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Card estándar del detalle (surface, radius 20, padding 22, gap 16, shadow-3). */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      {children}
    </section>
  );
}

/** Pill genérico por tono semántico. */
function Pill({
  tone,
  label,
}: {
  tone: 'brand' | 'purple' | 'success' | 'warn' | 'info' | 'neutral';
  label: string;
}) {
  const CLS: Record<string, string> = {
    brand: 'bg-accent/10 text-accent',
    purple: 'bg-[#7C3AED]/10 text-[#7C3AED]',
    success: 'bg-success/10 text-success',
    warn: 'bg-warn/10 text-warn',
    info: 'bg-[#0097CE]/10 text-[#0097CE]',
    neutral: 'bg-bg text-ink-muted',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${CLS[tone]}`}
    >
      {label}
    </span>
  );
}

function RolePill({ role }: { role: string }) {
  return <Pill tone={ROLE_TONE[role] ?? 'neutral'} label={ROLE_LABELS[role] ?? role} />;
}
