'use client';

import { useState } from 'react';
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

  async function verify() {
    setError(null);
    setPending(true);
    try {
      await stepUp(code);
      setOpen(false);
      setCode('');
      await onVerified();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Código incorrecto.');
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
