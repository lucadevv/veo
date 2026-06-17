'use client';

import type { SignedMedia } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface MediaPlayerProps {
  media: SignedMedia | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Reproductor de video con URL firmada y watermark visible permanente (auditoría). */
export function MediaPlayer({ media, open, onOpenChange }: MediaPlayerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reproducción de video</DialogTitle>
        </DialogHeader>
        {media ? (
          <div className="space-y-3">
            <div className="relative overflow-hidden rounded-md bg-black">
              <video src={media.url} controls className="aspect-video w-full">
                <track kind="captions" />
              </video>
              {/* Watermark visible no removible sobre el video. */}
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
                aria-hidden
              >
                <span className="rotate-[-20deg] select-none text-2xl font-bold uppercase tracking-widest text-white/25">
                  {media.watermark}
                </span>
              </div>
              <div className="pointer-events-none absolute bottom-2 right-3 select-none font-mono text-xs text-white/60">
                {media.watermark}
              </div>
            </div>
            <p className="text-xs text-ink-muted">
              Acceso temporal · expira {dateTime(media.expiresAt)}. Toda reproducción queda
              auditada.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
