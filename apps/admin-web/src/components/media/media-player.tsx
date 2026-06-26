'use client';

import { Loader2 } from 'lucide-react';
import type { SignedMedia } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/states';

interface MediaPlayerProps {
  /** Estado del acceso: PROCESSING (quemando el watermark) o READY (reproducible). `null` antes del primer fetch. */
  media: SignedMedia | null;
  /** El render falló de forma terminal o la verificación venció: se muestra el estado de error. */
  error: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Reproductor de video de cabina (BR-S02). El watermark forense (operador · motivo · fecha) viene QUEMADO
 * en cada frame por el media-service — NO es un overlay del cliente (sería removible). El quemado es
 * asíncrono: mientras se rinde, el modal muestra un estado honesto de preparación en el MISMO marco negro
 * (continuidad espacial) y la vista superior poll-ea hasta READY dentro de la ventana de MFA.
 */
export function MediaPlayer({ media, error, open, onOpenChange }: MediaPlayerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reproducción de video</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
            {error ? (
              <ErrorState
                title="No se pudo preparar el video"
                description="El procesamiento seguro no se completó o la verificación expiró. Cerrá y volvé a intentar."
                className="h-full"
              />
            ) : media?.status === 'READY' ? (
              // El watermark ya vive en el pixel: el <video> lo muestra permanente, sin overlay removible.
              <video src={media.url} controls className="h-full w-full">
                <track kind="captions" />
              </video>
            ) : (
              <Preparing />
            )}
          </div>

          {media?.status === 'READY' ? (
            <p className="text-xs text-ink-muted">
              Acceso temporal · expira {dateTime(media.expiresAt)}. Marca de agua permanente sobre cada
              frame. Toda reproducción queda auditada.
            </p>
          ) : !error ? (
            <p className="text-xs text-ink-muted">
              No cierres esta ventana: el video se abrirá en cuanto la copia segura esté lista.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Estado de preparación: el media-service está grabando el watermark forense en cada frame (re-encode). */
function Preparing() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid size-12 place-items-center rounded-lg bg-white/5 text-white/80">
        <Loader2 className="size-6 animate-spin" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-white">Preparando el video de forma segura</p>
        <p className="max-w-sm text-xs text-white/55">
          Se está grabando la marca de agua forense (operador, motivo y fecha) sobre cada frame. Tarda
          unos segundos y queda permanente.
        </p>
      </div>
    </div>
  );
}
