'use client';

import { useState } from 'react';
import { Check, PlayCircle, X } from 'lucide-react';
import { useDecideMedia, useSignedMedia } from '@/lib/api/queries';
import type { MediaAccessRequestView, SignedMedia } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { MediaPlayer } from './media-player';

/** Acciones sobre una solicitud de acceso a video: aprobar/rechazar y reproducir (con step-up). */
export function MediaActions({ request }: { request: MediaAccessRequestView }) {
  const user = useSession();
  const { toast } = useToast();
  const decide = useDecideMedia();
  const signed = useSignedMedia();
  const [media, setMedia] = useState<Extract<SignedMedia, { status: 'READY' }> | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);

  async function play() {
    const result = await signed.mutateAsync({ id: request.id });
    // El render del watermark es asíncrono (burn-in): si la copia aún se está quemando, avisar y reintentar.
    if (result.status === 'PROCESSING') {
      toast({
        tone: 'info',
        title: 'Preparando el video',
        description: 'Se está aplicando la marca de agua. Reintentá en unos segundos.',
      });
      return;
    }
    setMedia(result);
    setPlayerOpen(true);
  }

  return (
    <div className="flex items-center gap-2">
      {request.status === 'PENDING' && can(user, 'media:approve') ? (
        <>
          {/* Aprobar acceso a video exige doble-auth (step-up MFA). */}
          <StepUpDialog
            title="Aprobar acceso a video"
            description="Aprobar el acceso a grabaciones requiere verificación adicional."
            trigger={
              <Button size="sm" variant="primary">
                <Check className="size-4" aria-hidden />
                Aprobar
              </Button>
            }
            onVerified={async () => {
              await decide.mutateAsync({ id: request.id, decision: 'approve' });
              toast({ tone: 'success', title: 'Acceso aprobado' });
            }}
          />
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="secondary">
                <X className="size-4" aria-hidden />
                Rechazar
              </Button>
            }
            title="Rechazar solicitud"
            description="La solicitud de acceso a video será rechazada."
            confirmLabel="Rechazar"
            variant="danger"
            onConfirm={async () => {
              await decide.mutateAsync({ id: request.id, decision: 'reject' });
              toast({ tone: 'success', title: 'Solicitud rechazada' });
            }}
          />
        </>
      ) : null}

      {request.status === 'APPROVED' && can(user, 'media:view') ? (
        <StepUpDialog
          title="Reproducir video"
          description="Reproducir grabaciones requiere verificación adicional. Toda reproducción queda auditada."
          trigger={
            <Button size="sm" variant="primary" loading={signed.isPending}>
              <PlayCircle className="size-4" aria-hidden />
              Reproducir
            </Button>
          }
          onVerified={play}
        />
      ) : null}

      <MediaPlayer media={media} open={playerOpen} onOpenChange={setPlayerOpen} />
    </div>
  );
}
