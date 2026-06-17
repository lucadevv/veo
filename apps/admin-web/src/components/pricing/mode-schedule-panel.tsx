'use client';

import { Check, Gavel, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { ModeScheduleView, PricingMode } from '@/lib/api/schemas';
import { formatDayMask, formatWindow, modeDescription, modeLabel } from '@/lib/pricing';
import { dateTime } from '@/lib/formatters';
import { useReplaceSchedule } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';

const MODES: readonly { value: PricingMode; icon: LucideIcon }[] = [
  { value: 'PUJA', icon: Gavel },
  { value: 'FIXED', icon: Tag },
];

/**
 * Panel del modo de despacho global (default del schedule). El admin elige PUJA o FIJO; el cambio se
 * confirma (es global y afecta a TODOS los viajes nuevos) y reemplaza el schedule preservando las reglas
 * horarias existentes. El editor de FRANJAS (reglas por horario) se muestra read-only: es follow-up honesto,
 * no data falsa. La UI solo refleja el permiso `pricing:manage`; el admin-bff + trip-service re-autorizan.
 */
export function ModeSchedulePanel({ schedule }: { schedule: ModeScheduleView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const { toast } = useToast();
  const replace = useReplaceSchedule();

  async function switchTo(mode: PricingMode) {
    try {
      // Reemplazo wholesale: cambia el default y CONSERVA las reglas vigentes (no las pisa).
      // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió → 409.
      await replace.mutateAsync({
        defaultMode: mode,
        rules: schedule.rules,
        expectedVersion: schedule.version,
      });
      toast({ tone: 'success', title: `Modo global cambiado a ${modeLabel(mode)}` });
    } catch (err) {
      // 409 = otro admin cambió el schedule. El hook re-sincroniza (onSettled) → el panel muestra lo vigente.
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'El modo lo cambió otro admin. Recargamos lo vigente — revisá y reintentá.'
          : `No se pudo cambiar el modo${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-4">
      <section>
        <h2 className="text-sm font-medium text-ink-muted">Modo por defecto</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          Se aplica a todo viaje nuevo que no caiga dentro de una franja horaria definida.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {MODES.map(({ value, icon: Icon }) => {
            const active = schedule.defaultMode === value;
            const card = (
              <div
                className={`flex h-full flex-col gap-2 rounded-lg border p-4 text-left transition-colors ${
                  active
                    ? 'border-accent bg-accent/10'
                    : canManage
                      ? 'border-border hover:border-border-strong'
                      : 'border-border opacity-70'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold text-ink">
                    <Icon className="size-5 text-ink-muted" aria-hidden />
                    {modeLabel(value)}
                  </span>
                  {active ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-accent">
                      <Check className="size-4" aria-hidden /> Activo
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-ink-muted">{modeDescription(value)}</p>
              </div>
            );

            // El modo activo no se re-selecciona. Sin permiso, las tarjetas son informativas (no autoriza la UI).
            if (active || !canManage) {
              return (
                <div key={value} aria-current={active ? 'true' : undefined}>
                  {card}
                </div>
              );
            }

            return (
              <StepUpDialog
                key={value}
                trigger={
                  <button type="button" className="text-left" disabled={replace.isPending}>
                    {card}
                  </button>
                }
                title={`Cambiar modo global a ${modeLabel(value)}`}
                description={`Todos los viajes nuevos pasarán a ${modeLabel(
                  value,
                )}. Las franjas horarias definidas se conservan. Esta acción cambia el pricing global y queda auditada.`}
                onVerified={() => switchTo(value)}
              />
            );
          })}
        </div>
        {!canManage ? (
          <p className="mt-3 text-xs text-ink-subtle">
            Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar el modo.
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-sm font-medium text-ink-muted">Franjas horarias</h2>
        {schedule.rules.length === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">
            Sin franjas: rige siempre el modo por defecto. El editor de franjas por horario llega próximamente.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {schedule.rules.map((rule) => (
              <li
                key={`${rule.dayMask}-${rule.startMinute}-${rule.endMinute}-${rule.mode}`}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <span className="text-ink">{formatDayMask(rule.dayMask)}</span>
                <span className="tabular text-ink-muted">
                  {formatWindow(rule.startMinute, rule.endMinute)}
                </span>
                <span className="font-medium text-ink">{modeLabel(rule.mode)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-ink-subtle">
        Versión {schedule.version}
        {schedule.updatedAt ? ` · actualizado ${dateTime(schedule.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </div>
  );
}
