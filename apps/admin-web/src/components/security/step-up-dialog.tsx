'use client';

import { cloneElement, isValidElement, useState, type MouseEventHandler } from 'react';
import { KeyRound } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
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
  /** Se ejecuta tras verificar el TOTP (MFA fresco). */
  onVerified: () => Promise<void> | void;
}

/**
 * Verificación de segundo factor (step-up) para acciones sensibles, p. ej. video.
 * Pide el código TOTP, llama a /api/auth/step-up y solo entonces ejecuta la acción.
 */
export function StepUpDialog({
  trigger,
  title = 'Verificación adicional requerida',
  description = 'Esta acción accede a datos sensibles. Ingresa tu código TOTP para continuar.',
  onVerified,
}: StepUpDialogProps) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // DEV: espejo EXACTO del `StepUpMfaGuard` del backend (`if (!isHardenedEnv()) return true`): en
  // local/dev el server NO exige la doble-auth fresca, así que la UI tampoco debe pedir TOTP (el
  // superadmin opera sin re-tipear el código en cada acción sensible). El gate de ROL sigue server-side.
  // Solo NODE_ENV=production (preview Y prod) mantiene el step-up. Saltamos el diálogo y corremos la
  // acción directo cableando el onClick del trigger.
  if (process.env.NODE_ENV !== 'production' && isValidElement(trigger)) {
    return cloneElement(trigger as React.ReactElement<{ onClick?: MouseEventHandler }>, {
      onClick: () => void onVerified(),
    });
  }

  async function verify() {
    setError(null);
    setPending(true);
    try {
      // Verificamos el TOTP y EJECUTAMOS la acción con el diálogo AÚN abierto: si `onVerified` falla
      // (p. ej. el override de compliance devuelve 403 por causa-mismatch o 409 si ya no está suspendido),
      // el error queda visible en el Field en vez de perderse tras un diálogo ya cerrado. Cerramos SOLO en
      // éxito completo (mismo patrón que ConfirmDialog: await primero, setOpen(false) recién al final).
      await stepUp(code);
      await onVerified();
      setOpen(false);
      setCode('');
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
            <KeyRound className="size-5 text-accent" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label="Código TOTP" error={error ?? undefined}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="text-center font-mono text-lg tracking-[0.4em]"
            placeholder="••••••"
          />
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={pending}
            disabled={code.length < 6}
            onClick={() => void verify()}
          >
            Verificar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
