'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useRequestMedia } from '@/lib/api/queries';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Solicita acceso a la grabación de un viaje (queda PENDING hasta doble aprobación). `defaultTripId` pre-carga el
 * viaje — lo usa el deep-link de pánico (`/media?trip=`) cuando aún no hay solicitud para ese viaje.
 */
export function RequestAccessDialog({ defaultTripId = '' }: { defaultTripId?: string } = {}) {
  const { toast } = useToast();
  const request = useRequestMedia();
  const [open, setOpen] = useState(false);
  const [tripId, setTripId] = useState(defaultTripId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const valid = tripId.trim().length > 0 && reason.trim().length > 0;

  async function submit() {
    setError(null);
    try {
      await request.mutateAsync({ tripId: tripId.trim(), reason: reason.trim() });
      toast({
        tone: 'success',
        title: 'Solicitud enviada',
        description: 'Requiere doble aprobación.',
      });
      setOpen(false);
      setTripId(defaultTripId);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo enviar la solicitud.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="size-4" aria-hidden />
          Solicitar acceso
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Solicitar acceso a video</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="ID de viaje">
            <Input
              value={tripId}
              onChange={(e) => setTripId(e.target.value)}
              placeholder="UUID del viaje"
            />
          </Field>
          <Field label="Motivo de la solicitud" error={error ?? undefined}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={request.isPending}
            disabled={!valid}
            onClick={() => void submit()}
          >
            Enviar solicitud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
