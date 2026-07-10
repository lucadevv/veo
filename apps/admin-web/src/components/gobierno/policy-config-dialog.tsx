'use client';

import { useMemo, useState } from 'react';
import { Check, KeyRound, Minus, Plus, ShieldCheck, Wrench, X } from 'lucide-react';
import { AdminRole } from '@veo/shared-types';
import { DEFAULT_PARAMS, safeValidateParams, type PolicyDef } from '@veo/policy';
import type { PolicyView } from '@/lib/api/schemas';
import { describeParams, isNetNew, POLICY_ICONS, type ParamField } from '@/lib/gobierno';
import { stepUp } from '@/lib/api/auth';
import { useUpdatePolicy } from '@/lib/api/queries';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { OtpInput } from '@/components/ui/otp-input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Espejo del `StepUpMfaGuard` del backend: en dev el server no exige la MFA fresca, así que el TOTP se salta. */
const IS_PROD = process.env.NODE_ENV === 'production';

/** Opciones de roles para los chips: el set canónico AdminRole + cualquier valor vigente fuera de él (p. ej. el
 *  histórico "COMPLIANCE" del default de pii.mask), para no perder un valor guardado que no esté en el enum. */
function roleOptions(current: readonly string[]): string[] {
  const set = new Set<string>(Object.values(AdminRole));
  for (const r of current) set.add(r);
  return [...set];
}

/**
 * Editor GENÉRICO de los parámetros de una política, dirigido por el schema Zod del catálogo (`describeParams`)
 * — no hay 16 modales a mano. Renderiza: números como stepper (con min/max del propio schema), arrays de roles
 * como chips del set AdminRole, arrays libres (CIDRs) como chips de texto. Valida contra @veo/policy antes de
 * guardar y hace el PUT con step-up MFA (@RequireStepUpMfa en el bff): en prod pide el TOTP acá mismo (como
 * NewOperatorDialog), en dev lo salta. Reflejo del diseño AdminPoliticas-Config.
 */
export function PolicyConfigDialog({
  def,
  policy,
  canManage,
  trigger,
}: {
  def: PolicyDef;
  policy: PolicyView;
  canManage: boolean;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const fields = useMemo(() => describeParams(def), [def]);
  const Icon = POLICY_ICONS[def.key] ?? Wrench;
  const netNew = isNetNew(def.key);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl p-0">
        {/* key en `open` → cada apertura re-siembra el formulario con los params vigentes (sin estado stale). */}
        {open ? (
          <ConfigForm
            key={`${def.key}-${policy.version}`}
            def={def}
            policy={policy}
            fields={fields}
            canManage={canManage}
            netNew={netNew}
            Icon={Icon}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfigForm({
  def,
  policy,
  fields,
  canManage,
  netNew,
  Icon,
  onDone,
}: {
  def: PolicyDef;
  policy: PolicyView;
  fields: ParamField[];
  canManage: boolean;
  netNew: boolean;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdatePolicy();

  // Semilla: los params vigentes del backend, con los defaults del catálogo de respaldo por si falta alguna clave.
  const [params, setParams] = useState<Record<string, unknown>>(() => ({
    ...DEFAULT_PARAMS(def.key),
    ...policy.params,
  }));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function setParam(key: string, value: unknown) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  // Validación contra el schema Zod del catálogo (fuente única de forma · ADR §9): bloquea guardar si no cumple.
  const validation = safeValidateParams(def.key, params);
  const codeReady = !IS_PROD || code.length >= 6;

  async function save() {
    setError(null);
    if (!validation.success) return;
    try {
      if (IS_PROD) await stepUp(code);
      await update.mutateAsync({ key: def.key, params });
      toast({ tone: 'success', title: 'Política actualizada', description: def.label });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la política.');
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header (la X de cerrar la aporta DialogContent; dejamos padding-right para no chocar con ella). */}
      <div className="flex flex-col gap-2 border-b border-border px-6 pb-4 pt-6 pr-12">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.15em] text-ink-subtle">
            Configurar política
          </span>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Icon className="size-5 text-accent" aria-hidden />
            {def.label}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-ink-subtle">policy:{def.key}</span>
          {def.mandatory ? (
            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
              Ley 29733
            </span>
          ) : null}
          {netNew ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-border">
              Enforcement en desarrollo
            </span>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-6 px-6 py-5">
        <p className="text-sm text-ink-muted">{def.description}</p>

        {fields.map((field) => (
          <ParamControl
            key={field.key}
            field={field}
            value={params[field.key]}
            disabled={!canManage || update.isPending}
            onChange={(v) => setParam(field.key, v)}
          />
        ))}

        {!validation.success ? (
          <p role="alert" className="text-xs font-medium text-danger">
            Revisa los valores: alguno está fuera del rango permitido.
          </p>
        ) : null}

        {def.mandatory ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 p-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            <p className="text-xs text-warn">
              Protege datos sensibles bajo Ley 29733. Este candado no se puede desactivar; el cambio
              queda auditado de forma inmutable.
            </p>
          </div>
        ) : null}

        {netNew ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 p-3">
            <Wrench className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
            <p className="text-xs text-ink-muted">
              El enforcement de esta política aún no está cableado (ADR-024 §5): podés fijar sus
              parámetros, pero todavía no operan hasta que se implemente en una fase posterior.
            </p>
          </div>
        ) : null}

        {/* Step-up MFA inline (solo prod): el bff exige @RequireStepUpMfa en el PUT. */}
        {canManage && IS_PROD ? (
          <Field
            label="Código de 6 dígitos"
            hint="Cambiar una política de gobierno requiere verificación adicional (queda auditado)."
            error={error ?? undefined}
          >
            <OtpInput value={code} onChange={setCode} length={6} />
          </Field>
        ) : error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>

      {/* Footer */}
      <DialogFooter className="border-t border-border px-6 py-4">
        <DialogClose asChild>
          <Button variant="ghost">Cancelar</Button>
        </DialogClose>
        {canManage ? (
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!validation.success || !codeReady}
            onClick={() => void save()}
          >
            <KeyRound className="size-4" aria-hidden />
            Guardar cambios
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

/* ── Controles por tipo de parámetro ── */

function ParamControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-semibold text-ink">{field.label}</label>
      {field.help ? <p className="text-xs text-ink-muted">{field.help}</p> : null}
      {field.kind === 'number' ? (
        <NumberStepper
          value={typeof value === 'number' ? value : Number(value) || 0}
          min={field.min}
          max={field.max}
          unit={field.unit}
          disabled={disabled}
          onChange={onChange}
        />
      ) : field.kind === 'roles' ? (
        <RoleChips
          value={Array.isArray(value) ? (value as string[]) : []}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <StringChips
          value={Array.isArray(value) ? (value as string[]) : []}
          placeholder="p. ej. 190.234.0.0/16"
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function NumberStepper({
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  min: number | null;
  max: number | null;
  unit?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const clamp = (n: number) => {
    let v = n;
    if (min != null && v < min) v = min;
    if (max != null && v > max) v = max;
    return v;
  };
  return (
    <div className="flex items-center gap-3">
      <div className="inline-flex items-center overflow-hidden rounded-lg border border-border-strong">
        <button
          type="button"
          aria-label="Restar"
          disabled={disabled || (min != null && value <= min)}
          onClick={() => onChange(clamp(value - 1))}
          className="grid size-10 place-items-center text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Minus className="size-4" aria-hidden />
        </button>
        <input
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? value : ''}
          min={min ?? undefined}
          max={max ?? undefined}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Math.trunc(Number(e.target.value))))}
          aria-label="Valor"
          className="h-10 w-20 border-x border-border-strong bg-surface text-center font-mono text-sm text-ink outline-none disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Sumar"
          disabled={disabled || (max != null && value >= max)}
          onClick={() => onChange(clamp(value + 1))}
          className="grid size-10 place-items-center text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      {unit ? <span className="text-sm text-ink-subtle">{unit}</span> : null}
      {min != null || max != null ? (
        <span className="text-xs text-ink-subtle">
          {min != null ? `mín ${min}` : ''}
          {min != null && max != null ? ' · ' : ''}
          {max != null ? `máx ${max}` : ''}
        </span>
      ) : null}
    </div>
  );
}

function RoleChips({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  const options = roleOptions(value);
  function toggle(role: string) {
    onChange(value.includes(role) ? value.filter((r) => r !== role) : [...value, role]);
  }
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((role) => {
        const active = value.includes(role);
        return (
          <button
            key={role}
            type="button"
            role="checkbox"
            aria-checked={active}
            disabled={disabled}
            onClick={() => toggle(role)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs transition-colors',
              active
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-ink-muted hover:border-border-strong',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
          >
            {active ? <Check className="size-3.5" aria-hidden /> : null}
            {role}
          </button>
        );
      })}
    </div>
  );
}

function StringChips({
  value,
  placeholder,
  disabled,
  onChange,
}: {
  value: string[];
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const v = draft.trim();
    if (!v || value.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...value, v]);
    setDraft('');
  }
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-xs text-ink"
            >
              {item}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Quitar ${item}`}
                  onClick={() => onChange(value.filter((v) => v !== item))}
                  className="text-ink-subtle hover:text-danger"
                >
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-subtle">Sin reglas — sin restricción.</p>
      )}
      {!disabled ? (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            className="h-10 font-mono text-xs"
          />
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={!draft.trim()}>
            <Plus className="size-4" aria-hidden />
            Agregar
          </Button>
        </div>
      ) : null}
    </div>
  );
}
