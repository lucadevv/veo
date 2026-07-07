'use client';

import { useState } from 'react';
import { Gavel, Tag, Pencil, Trash2, Plus } from 'lucide-react';
import type { ModeScheduleView, PricingMode } from '@/lib/api/schemas';
import {
  DAY_BITS,
  formatDayMask,
  formatWindow,
  formatMinute,
  parseMinute,
  modeLabel,
} from '@/lib/pricing';
import { useReplaceSchedule } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useConfigSave } from '@/lib/use-config-save';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard } from '@/components/config/config-card';
import { cn } from '@/lib/cn';

/** Una regla del schedule (misma forma que el contrato — evita divergir del schema). */
type Rule = ModeScheduleView['rules'][number];

const MODES: readonly PricingMode[] = ['FIXED', 'PUJA'];

/** ¿Cambió la lista de reglas respecto de lo persistido? (para el dirty del guardado wholesale). */
function rulesEqual(a: readonly Rule[], b: readonly Rule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    if (o === undefined) return false;
    return (
      r.dayMask === o.dayMask &&
      r.startMinute === o.startMinute &&
      r.endMinute === o.endMinute &&
      r.mode === o.mode
    );
  });
}

/** Toggle segmentado FIJO | PUJA (para el modo por defecto y el modo de una regla). */
function ModeToggle({
  value,
  onChange,
}: {
  value: PricingMode;
  onChange: (mode: PricingMode) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border-strong bg-surface p-1">
      {MODES.map((mode) => {
        const active = value === mode;
        const Icon = mode === 'PUJA' ? Gavel : Tag;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            aria-pressed={active}
            className={cn(
              'flex items-center gap-1.5 rounded px-3 py-1 text-xs font-semibold transition-colors',
              active ? 'bg-surface-2 text-ink' : 'text-ink-subtle hover:text-ink-muted',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {modeLabel(mode)}
          </button>
        );
      })}
    </div>
  );
}

/** Pill de modo para la fila de regla: PUJA resaltada (warn), FIJO neutra. */
function ModePill({ mode }: { mode: PricingMode }) {
  const puja = mode === 'PUJA';
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-semibold',
        puja ? 'bg-warn/12 text-warn' : 'bg-surface-2 text-ink-muted',
      )}
    >
      {modeLabel(mode)}
    </span>
  );
}

/** Form de una franja (agregar o editar): días + ventana horaria + modo. Edita LOCAL; el commit lo hace el panel. */
function RuleForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Rule;
  onSave: (rule: Rule) => void;
  onCancel: () => void;
}) {
  const [dayMask, setDayMask] = useState(initial.dayMask);
  const [start, setStart] = useState(formatMinute(initial.startMinute));
  const [end, setEnd] = useState(formatMinute(initial.endMinute));
  const [mode, setMode] = useState<PricingMode>(initial.mode);

  const startMinute = parseMinute(start);
  const endMinute = parseMinute(end);
  const invalid =
    dayMask < 1 ||
    !Number.isFinite(startMinute) ||
    !Number.isFinite(endMinute) ||
    startMinute === endMinute;

  return (
    <div className="rounded-md border border-border-strong bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {DAY_BITS.map(({ bit, short }) => {
          const on = (dayMask & bit) !== 0;
          return (
            <button
              key={bit}
              type="button"
              onClick={() => setDayMask((prev) => prev ^ bit)}
              aria-pressed={on}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                on ? 'bg-brand/15 text-brand' : 'bg-surface text-ink-subtle hover:text-ink-muted',
              )}
            >
              {short}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Desde
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Hasta
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <ModeToggle value={mode} onChange={setMode} />
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-subtle hover:text-ink"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={invalid}
          onClick={() => onSave({ dayMask, startMinute, endMinute, mode })}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-semibold',
            invalid ? 'cursor-not-allowed bg-surface text-ink-subtle' : 'bg-brand text-white hover:opacity-90',
          )}
        >
          Guardar franja
        </button>
      </div>
    </div>
  );
}

/**
 * Modo de tarificación (ADR 011) — el frame del .pen: el MODO POR DEFECTO (FIJO/PUJA) + las REGLAS POR FRANJA
 * (ventana horaria → modo, excepciones al default). El editor de franjas es CRUD local (agregar/editar/borrar) y
 * el guardado es WHOLESALE (default + todas las reglas) detrás de step-up MFA — es global y afecta a todo viaje
 * nuevo. La UI solo refleja `pricing:manage`; el admin-bff + trip-service re-autorizan. CAS por `version`.
 */
export function ModeSchedulePanel({ schedule }: { schedule: ModeScheduleView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const replace = useReplaceSchedule();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el modo de tarificación',
    error: 'No se pudo guardar el modo de tarificación',
    success: (p) =>
      `Modo guardado · default ${modeLabel(p.defaultMode)} · ${p.rules.length} franja(s)`,
  });

  const [defaultMode, setDefaultMode] = useState<PricingMode>(schedule.defaultMode);
  const [rules, setRules] = useState<Rule[]>(schedule.rules);
  // Índice de la regla en edición, 'new' para una nueva, o null si no hay form abierto.
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const dirty = defaultMode !== schedule.defaultMode || !rulesEqual(rules, schedule.rules);

  // Guardado WHOLESALE: manda el default + todas las reglas; expectedVersion = CAS (409 si otro admin la movió).
  const onSave = () => save({ defaultMode, rules, expectedVersion: schedule.version });

  const upsertRule = (rule: Rule) => {
    setRules((prev) => (editing === 'new' ? [...prev, rule] : prev.map((r, i) => (i === editing ? rule : r))));
    setEditing(null);
  };

  return (
    <ConfigCard
      title="Modo de tarificación"
      tag="por franja"
      tagTone="warn"
      description="Franja horaria → modo (FIJO o PUJA). El modo por defecto rige, y las reglas por franja son las excepciones por hora."
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={editing !== null}
          saving={saving}
          onSave={onSave}
          title="Confirmar modo de tarificación"
          description="Esta acción cambia el modo global (default + franjas) para todos los viajes nuevos y queda auditada."
        />
      }
    >
      {/* Modo por defecto */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-ink-muted">Modo por defecto</span>
          <span className="text-xs text-ink-subtle">Rige cuando el viaje no cae dentro de ninguna franja.</span>
        </div>
        {canManage ? <ModeToggle value={defaultMode} onChange={setDefaultMode} /> : <ModePill mode={defaultMode} />}
      </div>

      {/* Reglas por franja */}
      <div className="space-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          Reglas por franja
        </span>

        {rules.length === 0 && editing !== 'new' ? (
          <p className="text-sm text-ink-subtle">Sin franjas: rige siempre el modo por defecto.</p>
        ) : (
          <ul className="space-y-2">
            {rules.map((rule, i) =>
              editing === i ? (
                <li key={`edit-${i}`}>
                  <RuleForm initial={rule} onSave={upsertRule} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li
                  key={`${rule.dayMask}-${rule.startMinute}-${rule.endMinute}-${rule.mode}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="tabular font-mono text-sm text-ink">
                      {formatWindow(rule.startMinute, rule.endMinute)}
                    </span>
                    <span className="text-xs text-ink-subtle">{formatDayMask(rule.dayMask)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ModePill mode={rule.mode} />
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditing(i)}
                          aria-label="Editar franja"
                          className="rounded-md p-1.5 text-ink-muted hover:bg-surface hover:text-ink"
                        >
                          <Pencil className="size-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                          aria-label="Borrar franja"
                          className="rounded-md p-1.5 text-ink-muted hover:bg-danger/12 hover:text-danger"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ),
            )}
            {editing === 'new' ? (
              <li>
                <RuleForm
                  initial={{ dayMask: 127, startMinute: 0, endMinute: 360, mode: 'PUJA' }}
                  onSave={upsertRule}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : null}
          </ul>
        )}

        {canManage && editing === null ? (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-ink"
          >
            <Plus className="size-4" aria-hidden /> Agregar regla
          </button>
        ) : null}
      </div>

      <ReadOnlyNote canManage={canManage} noun="el modo de tarificación" />
    </ConfigCard>
  );
}
