'use client';

import { useState } from 'react';
import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { useResolvePanic } from '@/lib/api/queries';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { OtpInput } from '@/components/ui/otp-input';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type Resolution = 'RESOLVED' | 'FALSE_ALARM';

/** Tope del motivo (espejo del @MaxLength(2000) del DTO server-side, defensa en profundidad UI). */
const MAX_NOTES = 2000;

const OUTCOMES: {
  value: Resolution;
  label: string;
  hint: string;
  icon: typeof CheckCircle2;
}[] = [
  {
    value: 'RESOLVED',
    label: 'Atendido / Resuelto',
    hint: 'La emergencia fue real y quedó atendida.',
    icon: CheckCircle2,
  },
  {
    value: 'FALSE_ALARM',
    label: 'Falsa alarma',
    hint: 'No hubo emergencia. Desenmascara la vista familiar.',
    icon: ShieldAlert,
  },
];

/**
 * Cierre de un incidente de pánico (POST /security/panics/:id/resolve). El operador ELIGE el desenlace —
 * RESOLVED (atendido) vs FALSE_ALARM (falsa alarma) — y opcionalmente deja un motivo que queda en el audit
 * (rendición de cuentas · Ley 29733). Es una acción crítica de seguridad → step-up MFA (TOTP) antes de
 * ejecutar, igual que evidencia/live-access (StepUpDialog): el server la exige con @RequireStepUpMfa, así que
 * sin la doble-auth fresca respondería 403. En dev el TOTP se salta (espejo del StepUpMfaGuard), pero el
 * diálogo se muestra igual para capturar el desenlace + motivo. El admin-bff revalida @Roles server-side.
 */
export function PanicResolveDialog({ id, trigger }: { id: string; trigger: React.ReactNode }) {
  const resolve = useResolvePanic();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [notes, setNotes] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Espejo del StepUpMfaGuard del backend: solo producción exige la doble-auth fresca; en dev el TOTP se salta.
  const isProd = process.env.NODE_ENV === 'production';

  const notesTrimmed = notes.trim();
  const notesValid = notesTrimmed.length <= MAX_NOTES;
  const codeReady = !isProd || code.length >= 6;
  const canConfirm = resolution !== null && notesValid && codeReady;

  function reset() {
    setResolution(null);
    setNotes('');
    setCode('');
    setError(null);
  }

  async function confirm() {
    if (!resolution) return;
    setError(null);
    setPending(true);
    try {
      // Verificamos el TOTP y ejecutamos con el diálogo AÚN abierto: si falla (403 step-up, 409 ya cerrado),
      // el error queda visible en vez de perderse tras un diálogo cerrado. En dev el stepUp se omite.
      if (isProd) await stepUp(code);
      await resolve.mutateAsync({
        id,
        resolution,
        ...(notesTrimmed ? { notes: notesTrimmed } : {}),
      });
      toast({
        tone: 'success',
        title: resolution === 'RESOLVED' ? 'Alerta resuelta' : 'Marcada como falsa alarma',
      });
      setOpen(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cerrar la alerta.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-accent" aria-hidden />
            Cerrar alerta de pánico
          </DialogTitle>
          <DialogDescription>
            Registra el desenlace del incidente. Esta acción queda auditada (Ley 29733).
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2" aria-label="Desenlace del incidente">
          {OUTCOMES.map((o) => {
            const selected = resolution === o.value;
            const Icon = o.icon;
            return (
              <label
                key={o.value}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
                  selected
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface-2/40 hover:border-border-strong'
                }`}
              >
                <input
                  type="radio"
                  name="panic-resolution"
                  value={o.value}
                  checked={selected}
                  onChange={() => setResolution(o.value)}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <Icon className="size-4 text-ink-muted" aria-hidden />
                    {o.label}
                  </span>
                  <span className="text-xs text-ink-subtle">{o.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <Field
          label="Notas de resolución (opcional)"
          error={notes.length > MAX_NOTES ? `Máximo ${MAX_NOTES} caracteres` : undefined}
        >
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Motivo del cierre (queda en el audit)…"
            className="w-full resize-none rounded-sm border border-border-strong bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-focus"
          />
        </Field>

        {isProd ? (
          <Field label="Código de 6 dígitos" error={error ?? undefined}>
            <OtpInput value={code} onChange={setCode} length={6} />
          </Field>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={pending}
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            {resolution === 'FALSE_ALARM' ? 'Marcar falsa alarma' : 'Resolver alerta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
