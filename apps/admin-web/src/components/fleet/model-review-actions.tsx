'use client';

import { useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useModelReviewAction, useReopenModel } from '@/lib/api/queries';
import type { VehicleModelReviewView } from '@/lib/api/schemas';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
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

const SEGMENTS = ['ECONOMY', 'MID', 'PREMIUM'] as const;
const ENERGY_SOURCES = ['GASOLINE_90', 'DIESEL', 'ELECTRIC'] as const;

/**
 * Aprobar / rechazar una solicitud de modelo (B5-2.c).
 * - Aprobar abre un form: el operador completa la ficha técnica (segment/energySource/efficiency) que el
 *   conductor no conoce, y opcionalmente corrige los asientos (prellenados con los del request).
 * - Rechazar pide confirmación (sin body). Ambas invalidan la cola vía el hook.
 */
export function ModelReviewActions({ model }: { model: VehicleModelReviewView }) {
  const action = useModelReviewAction();
  const reopen = useReopenModel();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    segment: SEGMENTS[0] as (typeof SEGMENTS)[number],
    energySource: ENERGY_SOURCES[0] as (typeof ENERGY_SOURCES)[number],
    efficiency: '',
    seats: String(model.seats),
  });

  const efficiencyNum = Number(form.efficiency);
  const efficiencyValid =
    form.efficiency.trim().length > 0 &&
    Number.isInteger(efficiencyNum) &&
    efficiencyNum >= 1 &&
    efficiencyNum <= 1000;
  const seatsNum = Number(form.seats);
  const seatsValid =
    form.seats.trim().length === 0 ||
    (Number.isInteger(seatsNum) && seatsNum >= 1 && seatsNum <= 20);
  const valid = efficiencyValid && seatsValid;

  async function approve() {
    setError(null);
    setPending(true);
    try {
      await action.mutateAsync({
        id: model.id,
        decision: 'approve',
        segment: form.segment,
        energySource: form.energySource,
        efficiency: efficiencyNum,
        ...(form.seats.trim().length > 0 ? { seats: seatsNum } : {}),
      });
      toast({ tone: 'success', title: 'Modelo aprobado' });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar el modelo.');
    } finally {
      setPending(false);
    }
  }

  async function reject() {
    await action.mutateAsync({ id: model.id, decision: 'reject' });
    toast({ tone: 'success', title: 'Solicitud rechazada' });
  }

  async function reopenModel() {
    await reopen.mutateAsync({ id: model.id });
    toast({ tone: 'success', title: 'Modelo reabierto para revisión' });
  }

  // Un modelo YA APROBADO no se aprueba/rechaza: se REABRE (APPROVED→PENDING_REVIEW) para corregir su ficha.
  if (model.status === 'APPROVED') {
    return (
      <div className="inline-flex items-center gap-2 justify-self-end">
        <ConfirmDialog
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink-muted transition-colors hover:bg-surface-2"
            >
              <RotateCcw className="size-[13px]" aria-hidden />
              Reabrir
            </button>
          }
          title="Reabrir modelo aprobado"
          description={`Se reabrirá ${model.make} ${model.model} para corregir su ficha técnica. Volverá a la cola de revisión (pendiente) hasta que se apruebe de nuevo.`}
          confirmLabel="Reabrir"
          onConfirm={reopenModel}
        />
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 justify-self-end">
      <ConfirmDialog
        trigger={
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink-muted transition-colors hover:bg-surface-2"
          >
            Rechazar
          </button>
        }
        title="Rechazar solicitud de modelo"
        description={`Se descartará la solicitud de ${model.make} ${model.model}. El conductor deberá volver a solicitarlo.`}
        confirmLabel="Rechazar"
        variant="danger"
        onConfirm={reject}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent/15 px-3.5 py-2 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            <Check className="size-[13px]" aria-hidden />
            Aprobar
          </button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aprobar modelo</DialogTitle>
            <DialogDescription>
              Completá la ficha técnica de {model.make} {model.model} ({model.yearFrom}–
              {model.yearTo}). El servidor valida los enums de dominio y mueve la solicitud a
              APROBADO.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Segmento">
                <Select
                  value={form.segment}
                  onChange={(e) =>
                    setForm({ ...form, segment: e.target.value as (typeof SEGMENTS)[number] })
                  }
                >
                  {SEGMENTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Energía">
                <Select
                  value={form.energySource}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      energySource: e.target.value as (typeof ENERGY_SOURCES)[number],
                    })
                  }
                >
                  {ENERGY_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Eficiencia (1–1000)">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={form.efficiency}
                  onChange={(e) => setForm({ ...form, efficiency: e.target.value })}
                  placeholder="Ej. 45"
                />
              </Field>
              <Field label="Asientos (opcional)">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={form.seats}
                  onChange={(e) => setForm({ ...form, seats: e.target.value })}
                />
              </Field>
            </div>
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
              onClick={() => void approve()}
            >
              Aprobar modelo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
