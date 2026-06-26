'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [media, setMedia] = useState<SignedMedia | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playError, setPlayError] = useState(false);

  /**
   * Reproducir: el watermark se quema async (burn-in). El primer fetch suele venir PROCESSING; en vez de
   * pedirle al operador que reintente a mano (y rehaga el MFA), abrimos el modal en "preparando" y poll-eamos.
   * El step-up MFA es por VENTANA (fresco 5 min), y el render peor-caso (~140s) entra holgado en esa ventana,
   * así que el poll resuelve sin re-promptear. La identidad firmada ya viaja en cada request del cliente.
   */
  async function play() {
    setPlayError(false);
    try {
      const result = await signed.mutateAsync({ id: request.id });
      setMedia(result);
      setPlayerOpen(true);
    } catch {
      setMedia(null);
      setPlayError(true);
      setPlayerOpen(true);
    }
  }

  // Poll mientras la copia se está quemando. Para al quedar READY, al fallar, al agotar la espera, o al cerrar.
  const POLL_MS = 3500;
  const MAX_POLLS = 50; // ~3 min de techo (cubre el render + holgura; antes de que venza la ventana MFA).
  const pollsRef = useRef(0);
  useEffect(() => {
    if (!playerOpen || media?.status !== 'PROCESSING') return;
    pollsRef.current = 0;
    let active = true;
    const timer = setInterval(() => {
      pollsRef.current += 1;
      void signed
        .mutateAsync({ id: request.id })
        .then((result) => {
          if (!active) return;
          if (result.status === 'READY') {
            setMedia(result);
          } else if (pollsRef.current >= MAX_POLLS) {
            setMedia(null);
            setPlayError(true);
          }
        })
        .catch(() => {
          if (!active) return;
          setMedia(null);
          setPlayError(true);
        });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // `signed.mutateAsync` es estable (react-query); el ciclo depende del estado de la copia y del request.
  }, [playerOpen, media?.status, request.id]);

  // Al cerrar el modal, limpiamos el estado para que un próximo "Reproducir" arranque fresco.
  function onPlayerOpenChange(next: boolean) {
    setPlayerOpen(next);
    if (!next) {
      setMedia(null);
      setPlayError(false);
    }
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

      <MediaPlayer
        media={media}
        error={playError}
        open={playerOpen}
        onOpenChange={onPlayerOpenChange}
      />
    </div>
  );
}
