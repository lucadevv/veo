'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';

interface ConfirmDialogProps {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
  /** Si true, pide un motivo obligatorio antes de confirmar. */
  withReason?: boolean;
  reasonLabel?: string;
  /**
   * Acciones IRREVERSIBLES: exige escribir esta frase EXACTA (ej. el nombre del recurso o "ELIMINAR")
   * para habilitar el botón de confirmar. Es una barrera de fricción deliberada, no un campo de motivo.
   */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
  onConfirm: (reason?: string) => Promise<void>;
}

/** Diálogo de confirmación reutilizable para acciones sensibles (con motivo opcional). */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Confirmar',
  variant = 'primary',
  withReason = false,
  reasonLabel = 'Motivo',
  confirmPhrase,
  confirmPhraseLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [phrase, setPhrase] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El botón se habilita solo cuando se cumplen las barreras pedidas: motivo no vacío (withReason) y/o
  // la frase exacta tipeada (confirmPhrase). Sin barreras, está siempre habilitado.
  const reasonBlocked = withReason && reason.trim().length === 0;
  const phraseBlocked = confirmPhrase !== undefined && phrase !== confirmPhrase;
  const confirmDisabled = reasonBlocked || phraseBlocked;

  async function handleConfirm() {
    setError(null);
    setPending(true);
    try {
      await onConfirm(withReason ? reason : undefined);
      setOpen(false);
      setReason('');
      setPhrase('');
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {withReason ? (
          <Field label={reasonLabel} error={confirmPhrase ? undefined : (error ?? undefined)}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}

        {confirmPhrase !== undefined ? (
          <Field
            label={confirmPhraseLabel ?? `Escribe «${confirmPhrase}» para confirmar`}
            error={error ?? undefined}
          >
            <Input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              placeholder={confirmPhrase}
            />
          </Field>
        ) : null}

        {!withReason && confirmPhrase === undefined && error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant={variant}
            loading={pending}
            disabled={confirmDisabled}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
