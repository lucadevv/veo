'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Siren, Video } from 'lucide-react';
import { useOpsStore } from '@/lib/realtime/ops-store';
import { usePanicAction } from '@/lib/api/queries';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

/**
 * Modal interruptor de PÁNICO (fiel al frame SFHDF) — se abre una vez por cada pánico NUEVO en vivo, por
 * encima del banner persistente. Máxima prioridad: scrim + diálogo centrado que exige atención inmediata.
 *
 * CTAs REALES (el board traía labels placeholder "Mantener viaje/Sí, cancelar" heredados del modal de cancelar):
 *  - "Ver cámara en vivo" → detalle del pánico (/security/panics/:id), donde vive el acceso a video (doble auth).
 *  - "Atender" → ACK real (POST /security/panics/:id/ack).
 * Cuerpo HONESTO: el payload vivo solo trae tripId + geo (sin nombre del pasajero ni distrito) → no se inventan.
 */
export function PanicModal() {
  const router = useRouter();
  const { toast } = useToast();
  const panics = useOpsStore((s) => s.panics);
  const ack = usePanicAction();
  const [seen, setSeen] = useState<Set<string>>(new Set());

  // El primer pánico aún no visto en esta sesión gobierna el modal (los siguientes se muestran al cerrarlo).
  const target = panics.find((p) => !seen.has(p.panicId)) ?? null;
  const open = target != null;

  function markSeen() {
    if (target) setSeen((prev) => new Set(prev).add(target.panicId));
  }

  function onCamera() {
    if (!target) return;
    router.push(`/security/panics/${target.panicId}`);
    markSeen();
  }

  async function onAck() {
    if (!target) return;
    try {
      await ack.mutateAsync({ id: target.panicId, action: 'ack' });
      toast({ title: 'Pánico reconocido', tone: 'success' });
    } catch (e) {
      toast({
        title: 'No se pudo reconocer el pánico',
        description: e instanceof Error ? e.message : undefined,
        tone: 'danger',
      });
    } finally {
      markSeen();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? markSeen() : undefined)}>
      <DialogContent className="max-w-[420px] p-[30px]">
        <div className="flex flex-col items-center gap-5 text-center">
          <span className="grid size-[52px] place-items-center rounded-[14px] bg-danger/10 text-danger">
            <Siren className="size-[26px]" aria-hidden />
          </span>
          <div className="flex flex-col gap-2">
            <DialogTitle className="font-display text-[22px] font-bold tracking-[-0.4px] text-ink">
              Pánico activo · #{target?.panicId.slice(0, 8) ?? ''}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-ink-muted">
              Se activó el pánico en el viaje #{target?.tripId.slice(0, 8) ?? ''}. Revisá la cámara en
              vivo y atendé de inmediato.
            </DialogDescription>
          </div>
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={onCamera}
              className="flex w-full items-center justify-center gap-2 rounded-control bg-danger px-5 py-3.5 text-[15px] font-semibold text-danger-on transition-colors hover:bg-danger-hover"
            >
              <Video className="size-[18px]" aria-hidden />
              Ver cámara en vivo
            </button>
            <button
              type="button"
              onClick={() => void onAck()}
              disabled={ack.isPending}
              className="w-full rounded-control border border-border bg-surface px-5 py-3.5 text-[15px] font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-60"
            >
              {ack.isPending ? 'Atendiendo…' : 'Atender'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
