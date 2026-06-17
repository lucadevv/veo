'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { useLiveCameraToken } from '@/lib/api/queries';
import type { LiveViewerToken } from '@/lib/api/schemas';
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

/** El bff exige > 20 caracteres de motivo; lo reflejamos en la UI (el servidor revalida igual). */
const MIN_REASON = 21;

/**
 * Doble-auth para abrir una cabina EN VIVO (muro admin): motivo (auditado) + step-up MFA en un solo paso.
 * Verifica el TOTP (`stepUp`) ANTES de pedir el token; el bff vuelve a exigir MFA fresca + rol y audita el
 * motivo. Al obtener el token, lo entrega vía `onGranted` (el muro abre el viewer). La UI nunca autoriza.
 */
export function LiveAccessDialog({
  tripId,
  trigger,
  onGranted,
}: {
  tripId: string;
  trigger: React.ReactNode;
  onGranted: (grant: LiveViewerToken) => void;
}) {
  const live = useLiveCameraToken();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonOk = reason.trim().length >= MIN_REASON;

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await stepUp(code); // 1) segundo factor: MFA fresca en la sesión
      const grant = await live.mutateAsync({ tripId, reason }); // 2) token (auditado server-side con el motivo)
      setOpen(false);
      setReason('');
      setCode('');
      onGranted(grant);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo abrir la cámara en vivo.');
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
            Ver cabina en vivo
          </DialogTitle>
          <DialogDescription>
            Mirar una cabina en vivo accede a datos sensibles y queda auditado. Indica el motivo y
            verifica tu segundo factor.
          </DialogDescription>
        </DialogHeader>
        <Field
          label={`Motivo (mín. ${MIN_REASON} caracteres)`}
          error={!reasonOk && reason.length > 0 ? 'Describe el motivo con más detalle.' : undefined}
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej. verificación de incidente reportado por el pasajero…"
          />
        </Field>
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
            disabled={!reasonOk || code.length < 6}
            onClick={() => void submit()}
          >
            Abrir cámara
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
