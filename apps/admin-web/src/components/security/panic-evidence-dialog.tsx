'use client';

import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { useAttachPanicEvidence } from '@/lib/api/queries';
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

/** Tope de claves por adjunto (espejo del DTO server-side, defensa en profundidad UI). */
const MAX_KEYS = 50;

/**
 * Adjuntar / proteger evidencia de un incidente de pánico (POST /security/panics/:id/evidence). Captura las
 * claves S3 ya subidas (una por línea) y, opcionalmente, `finalize` para PROTEGERLAS con retención/object-lock
 * (cadena de custodia · Ley 29733). Es una acción sensible de seguridad → step-up MFA (TOTP) antes de ejecutar,
 * igual que aprobar/borrar (StepUpDialog). En dev el TOTP se omite (espejo del StepUpMfaGuard del backend), pero
 * el diálogo se muestra igual para capturar las claves. El admin-bff revalida @Roles server-side; la UI refleja.
 */
export function PanicEvidenceDialog({ id, trigger }: { id: string; trigger: React.ReactNode }) {
  const attach = useAttachPanicEvidence();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [keysText, setKeysText] = useState('');
  const [finalize, setFinalize] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Espejo del StepUpMfaGuard del backend: solo producción exige la doble-auth fresca; en dev el TOTP se salta.
  const isProd = process.env.NODE_ENV === 'production';

  const keys = keysText
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter(Boolean);
  const keysValid = keys.length >= 1 && keys.length <= MAX_KEYS;
  const codeReady = !isProd || code.length >= 6;

  async function confirm() {
    setError(null);
    setPending(true);
    try {
      // Verificamos el TOTP y ejecutamos con el diálogo AÚN abierto: si falla (403/409), el error queda visible.
      if (isProd) await stepUp(code);
      const res = await attach.mutateAsync({ id, keys, finalize });
      toast({
        tone: 'success',
        title: 'Evidencia adjuntada',
        description: `${res.evidenceS3Keys.length} clave(s) en el incidente${
          finalize ? ` · ${res.protectedKeys.length} protegida(s)` : ''
        }`,
      });
      setOpen(false);
      setKeysText('');
      setFinalize(false);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo adjuntar la evidencia.');
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
            <Paperclip className="size-5 text-accent" aria-hidden />
            Adjuntar evidencia
          </DialogTitle>
          <DialogDescription>
            Pegá las claves S3 de la evidencia ya subida (una por línea). Protegerla aplica retención
            (object-lock) para la cadena de custodia. La acción queda auditada.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Claves S3 (una por línea)"
          error={keys.length > MAX_KEYS ? `Máximo ${MAX_KEYS} claves` : undefined}
        >
          <textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            rows={4}
            placeholder={'panic/evidence/2026/…\npanic/evidence/2026/…'}
            className="w-full resize-none rounded-sm border border-border-strong bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-focus"
          />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-surface-2/40 px-3 py-2.5">
          <input
            type="checkbox"
            checked={finalize}
            onChange={(e) => setFinalize(e.target.checked)}
            className="mt-0.5 size-4 accent-accent"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">Proteger con retención (object-lock)</span>
            <span className="text-xs text-ink-subtle">
              Irreversible: fija las claves para la cadena de custodia (Ley 29733).
            </span>
          </span>
        </label>
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
            disabled={!keysValid || !codeReady}
            onClick={() => void confirm()}
          >
            {finalize ? 'Adjuntar y proteger' : 'Adjuntar evidencia'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
