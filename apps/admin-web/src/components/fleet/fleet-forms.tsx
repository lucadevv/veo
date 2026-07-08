'use client';

import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useCreateInspection } from '@/lib/api/queries';
import { useToast } from '@/components/ui/toast';
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

/** Estilo del <select> nativo, espejo del Input (admin-web no tiene primitive Select aún). */
const selectClass =
  'h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink ' +
  'hover:border-border-strong focus-visible:outline-none';

/** Botón "Crear" estándar para los encabezados de pestaña. */
function CreateTrigger({ label }: { label: string }) {
  return (
    <Button size="sm" variant="primary">
      <Plus className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

/* ── Alta de inspección ──
 * Reusable: sin props es el alta genérica de Flota (el operador tipea el uuid). Con `vehicleId` precargado
 * (p.ej. desde la barra de aprobación del conductor) el vehículo viene FIJO y se muestra su placa — el
 * operador no pega uuids ni se equivoca de vehículo. `onCreated` deja refrescar el contexto llamador. */
export function CreateInspectionDialog({
  vehicleId: presetVehicleId,
  vehicleLabel,
  trigger,
  onCreated,
}: {
  vehicleId?: string;
  vehicleLabel?: string;
  trigger?: ReactNode;
  onCreated?: () => void;
} = {}) {
  const create = useCreateInspection();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    vehicleId: presetVehicleId ?? '',
    passed: 'true',
    inspectedAt: '',
    center: '',
    notes: '',
  });

  const locked = Boolean(presetVehicleId);
  const valid = form.vehicleId.trim().length > 0;

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await create.mutateAsync({
        vehicleId: form.vehicleId.trim(),
        passed: form.passed === 'true',
        inspectedAt: form.inspectedAt || undefined,
        center: form.center.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast({ tone: 'success', title: 'Inspección registrada' });
      setOpen(false);
      setForm({
        vehicleId: presetVehicleId ?? '',
        passed: 'true',
        inspectedAt: '',
        center: '',
        notes: '',
      });
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la inspección.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <span>{trigger ?? <CreateTrigger label="Registrar inspección" />}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar inspección técnica</DialogTitle>
          <DialogDescription>
            El servidor calcula el próximo vencimiento (BR-D04: trimestral).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <Field label="Vehículo">
            {locked ? (
              <div className="flex h-11 items-center rounded-md border border-border bg-surface-2 px-3 text-sm text-ink">
                {vehicleLabel ?? form.vehicleId}
              </div>
            ) : (
              <Input
                value={form.vehicleId}
                onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}
                placeholder="uuid del vehículo"
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Resultado">
              <select
                className={selectClass}
                value={form.passed}
                onChange={(e) => setForm({ ...form, passed: e.target.value })}
              >
                <option value="true">Aprobada</option>
                <option value="false">Rechazada</option>
              </select>
            </Field>
            <Field label="Fecha (opcional)">
              <Input
                type="date"
                value={form.inspectedAt}
                onChange={(e) => setForm({ ...form, inspectedAt: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Centro (CITV) (opcional)">
            <Input
              value={form.center}
              onChange={(e) => setForm({ ...form, center: e.target.value })}
              placeholder="Ej. CITV Lima Norte"
            />
          </Field>
          <Field label="Notas (opcional)">
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={pending}
            disabled={!valid}
            onClick={() => void submit()}
          >
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
