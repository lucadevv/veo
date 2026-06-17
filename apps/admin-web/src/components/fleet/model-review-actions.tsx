'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useModelReviewAction } from '@/lib/api/queries';
import type { ApproveVehicleModelRequest, VehicleModelReviewView } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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

/** Estilo del <select> nativo, espejo del Input (admin-web no tiene primitive Select aún). */
const selectClass =
  'h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink ' +
  'hover:border-border-strong focus-visible:outline-none';

/** Opciones de la ficha técnica que completa el operador. Los valores espejan los enums del contrato. */
const SEGMENT_OPTIONS = [
  { value: 'ECONOMY', label: 'Económico' },
  { value: 'MID', label: 'Intermedio' },
  { value: 'PREMIUM', label: 'Premium' },
] as const;
const ENERGY_OPTIONS = [
  { value: 'GASOLINE_95', label: 'Gasolina 95' },
  { value: 'GASOLINE_84', label: 'Gasolina 84' },
  { value: 'DIESEL', label: 'Diésel' },
  { value: 'GNV', label: 'GNV' },
  { value: 'ELECTRIC', label: 'Eléctrico' },
] as const;

/**
 * Acciones de revisión de un modelo solicitado (B5-2.c), gated por `fleet:review`. Solo se revisa lo que
 * está PENDING_REVIEW. Aprobar abre un formulario para completar la ficha técnica (segmento/energía/
 * rendimiento) que el conductor no conoce; rechazar es un confirm. La acción queda auditada server-side.
 */
export function ModelReviewActions({ model }: { model: VehicleModelReviewView }) {
  const user = useSession();
  const { toast } = useToast();
  const action = useModelReviewAction();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    segment: '',
    energySource: '',
    efficiency: '',
    seats: String(model.seats),
  });

  // `model.status` es el enum tipado del contrato; el literal se chequea contra el union (typo = error TS).
  if (!can(user, 'fleet:review') || model.status !== 'PENDING_REVIEW') {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  const valid =
    form.segment && form.energySource && Number(form.efficiency) > 0 && Number(form.seats) > 0;

  async function approve() {
    setError(null);
    setPending(true);
    try {
      await action.mutateAsync({
        id: model.id,
        decision: 'approve',
        // El <select> solo ofrece valores válidos del enum; el contrato (Zod) y el fleet revalidan.
        segment: form.segment as ApproveVehicleModelRequest['segment'],
        energySource: form.energySource as ApproveVehicleModelRequest['energySource'],
        efficiency: Number(form.efficiency),
        seats: Number(form.seats),
      });
      toast({
        tone: 'success',
        title: 'Modelo aprobado',
        description: `${model.make} ${model.model}`,
      });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar el modelo.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="primary">
            <Check className="size-4" aria-hidden />
            Aprobar
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Aprobar {model.make} {model.model}
            </DialogTitle>
            <DialogDescription>
              Completá la ficha técnica de fábrica. El conductor solo indicó marca, modelo, años y
              asientos.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <Field label="Segmento">
              <select
                className={selectClass}
                value={form.segment}
                onChange={(e) => setForm((f) => ({ ...f, segment: e.target.value }))}
              >
                <option value="" disabled>
                  Elegí el segmento
                </option>
                {SEGMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Fuente de energía">
              <select
                className={selectClass}
                value={form.energySource}
                onChange={(e) => setForm((f) => ({ ...f, energySource: e.target.value }))}
              >
                <option value="" disabled>
                  Elegí la energía
                </option>
                {ENERGY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Rendimiento (km por unidad: km/L o km/kWh)">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                value={form.efficiency}
                onChange={(e) => setForm((f) => ({ ...f, efficiency: e.target.value }))}
                placeholder="17"
              />
            </Field>

            <Field label="Asientos (corregí si el conductor se equivocó)">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                value={form.seats}
                onChange={(e) => setForm((f) => ({ ...f, seats: e.target.value }))}
              />
            </Field>

            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancelar</Button>
            </DialogClose>
            <Button variant="primary" disabled={!valid || pending} onClick={() => void approve()}>
              {pending ? 'Aprobando…' : 'Aprobar modelo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar modelo"
        description="La solicitud quedará rechazada. La acción queda auditada."
        confirmLabel="Rechazar"
        variant="danger"
        onConfirm={async () => {
          // El reject es un CAS server-side: puede 409 si otro operador ya lo resolvió. Feedback honesto.
          try {
            await action.mutateAsync({ id: model.id, decision: 'reject' });
            toast({ tone: 'success', title: 'Modelo rechazado' });
          } catch (e) {
            toast({
              tone: 'danger',
              title: 'No se pudo rechazar',
              description: e instanceof Error ? e.message : undefined,
            });
          }
        }}
      />
    </div>
  );
}
