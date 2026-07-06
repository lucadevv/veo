'use client';

import { cloneElement, isValidElement, useState, type MouseEventHandler } from 'react';
import { KeyRound, type LucideIcon } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { OtpInput } from '@/components/ui/otp-input';
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

interface StepUpDialogProps {
  trigger: React.ReactNode;
  title?: string;
  description?: string;
  /** Ícono del encabezado (default KeyRound). Los frames usan shield-check (aprobar) / triangle-alert (rechazar). */
  icon?: LucideIcon;
  /** Botón de confirmar (default "Verificar"). El de un rechazo/borrado conviene nombrarlo con el verbo. */
  confirmLabel?: string;
  /** Variante del botón de confirmar (danger para rechazos/borrados). */
  confirmVariant?: 'primary' | 'danger';
  /** Pide un MOTIVO (textarea) además del TOTP. El motivo se pasa a `onVerified`. Para rechazos que el
   *  destinatario VE (approve/reject de conductor con MFA · frame AdminConductorDetalle-Rechazar). */
  withReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Se ejecuta tras verificar el TOTP (MFA fresco) — con el motivo si `withReason`. El valor que resuelva se
   *  ignora (algunos `save` devuelven `boolean` para short-circuit) → se acepta cualquier Promise. */
  onVerified: (reason?: string) => void | Promise<unknown>;
}

/**
 * Verificación de segundo factor (step-up) para acciones sensibles: video, aprobar/rechazar conductor (BR-S07),
 * borrar. Pide el TOTP, llama a /api/auth/step-up y solo entonces ejecuta la acción. Con `withReason` captura
 * además un motivo (el frame de rechazo lleva motivo + MFA en el mismo modal).
 */
export function StepUpDialog({
  trigger,
  title = 'Verificación adicional requerida',
  description = 'Esta acción accede a datos sensibles. Ingresa tu código TOTP para continuar.',
  icon: Icon = KeyRound,
  confirmLabel = 'Verificar',
  confirmVariant = 'primary',
  withReason = false,
  reasonLabel = 'Motivo',
  reasonPlaceholder,
  onVerified,
}: StepUpDialogProps) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Espejo EXACTO del `StepUpMfaGuard` del backend (`if (!isHardenedEnv()) return true`): en local/dev el server
  // NO exige la doble-auth fresca (solo NODE_ENV=production la mantiene). El TOTP se salta en dev.
  const isProd = process.env.NODE_ENV === 'production';

  // DEV sin motivo: no hay nada que capturar → salta el diálogo y corre la acción directo (el superadmin no
  // re-tipea el código en cada acción sensible). CON motivo NO se salta: el diálogo debe capturar el motivo
  // igual (dev o prod); solo el TOTP se omite en dev.
  if (!isProd && !withReason && isValidElement(trigger)) {
    return cloneElement(trigger as React.ReactElement<{ onClick?: MouseEventHandler }>, {
      onClick: () => void onVerified(),
    });
  }

  const reasonReady = !withReason || reason.trim().length > 0;
  const codeReady = !isProd || code.length >= 6;

  async function verify() {
    setError(null);
    setPending(true);
    try {
      // Verificamos el TOTP y EJECUTAMOS con el diálogo AÚN abierto: si `onVerified` falla (403 causa-mismatch,
      // 409 estado), el error queda visible en el Field en vez de perderse tras un diálogo cerrado. En dev se
      // omite el stepUp (el guard del backend también). Cerramos SOLO en éxito completo.
      if (isProd) await stepUp(code);
      await onVerified(withReason ? reason.trim() : undefined);
      setOpen(false);
      setCode('');
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la acción.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-5 text-accent" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {withReason ? (
          <Field label={reasonLabel}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={reasonPlaceholder}
              className="w-full resize-none rounded-sm border border-border-strong bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-focus"
            />
          </Field>
        ) : null}
        {isProd ? (
          <Field label="Código de 6 dígitos" error={error ?? undefined}>
            <OtpInput value={code} onChange={setCode} length={6} autoFocus={!withReason} />
          </Field>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant={confirmVariant}
            loading={pending}
            disabled={!reasonReady || !codeReady}
            onClick={() => void verify()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
