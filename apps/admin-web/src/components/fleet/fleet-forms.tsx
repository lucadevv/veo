'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { FleetDocumentType } from '@veo/shared-types';
import {
  useCatalog,
  useCreateDocument,
  useCreateInspection,
  useCreateVehicle,
  useVehicleModels,
} from '@/lib/api/queries';
import { certificationTypesForEnabledOfferings, documentTypeLabel } from '@/lib/certifications';
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

const DOCUMENT_TYPES = ['LICENSE_A1', 'SOAT', 'PROPERTY_CARD', 'BACKGROUND_CHECK', 'ITV'] as const;

/** Botón "Crear" estándar para los encabezados de pestaña. */
function CreateTrigger({ label }: { label: string }) {
  return (
    <Button size="sm" variant="primary">
      <Plus className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

/* ── Alta de vehículo (F4 · C2: por CATÁLOGO, no texto libre) ── */
export function CreateVehicleDialog() {
  const create = useCreateVehicle();
  // El operador elige un modelo del catálogo curado (mismo origen que el conductor en el onboarding): make/
  // model/tipo los snapshotea el fleet-service del spec elegido (server-authoritative), sin texto libre.
  const models = useVehicleModels();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    plate: '',
    modelSpecId: '',
    year: '',
    color: '',
    insuranceExpiresAt: '',
  });

  // Catálogo ordenado alfabético para el selector (la query trae una página; el catálogo curado es chico).
  const modelItems = useMemo(
    () =>
      [...(models.data?.items ?? [])].sort((a, b) =>
        `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`),
      ),
    [models.data],
  );
  const selectedModel = modelItems.find((m) => m.id === form.modelSpecId);

  const valid = Boolean(form.plate.trim() && form.modelSpecId && form.color.trim() && form.year);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await create.mutateAsync({
        plate: form.plate.trim().toUpperCase(),
        modelSpecId: form.modelSpecId,
        year: Number(form.year),
        color: form.color.trim(),
        insuranceExpiresAt: form.insuranceExpiresAt || undefined,
      });
      toast({ tone: 'success', title: 'Vehículo registrado' });
      setOpen(false);
      setForm({ plate: '', modelSpecId: '', year: '', color: '', insuranceExpiresAt: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar el vehículo.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <span>
          <CreateTrigger label="Registrar vehículo" />
        </span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar vehículo</DialogTitle>
          <DialogDescription>
            El modelo sale del catálogo curado; el año mínimo y la placa los revalida el servidor (BR-D04).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <Field label="Modelo (catálogo)">
            <select
              className={selectClass}
              value={form.modelSpecId}
              onChange={(e) => setForm({ ...form, modelSpecId: e.target.value })}
              disabled={models.isLoading}
            >
              <option value="" disabled>
                {models.isLoading
                  ? 'Cargando catálogo…'
                  : modelItems.length
                    ? 'Elegí un modelo…'
                    : 'No hay modelos aprobados en el catálogo'}
              </option>
              {modelItems.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.make} {m.model} · {m.yearFrom}–{m.yearTo}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Placa">
              <Input
                value={form.plate}
                onChange={(e) => setForm({ ...form, plate: e.target.value })}
                placeholder="ABC-123"
              />
            </Field>
            <Field label="Año">
              <Input
                type="number"
                inputMode="numeric"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
                placeholder={selectedModel ? `${selectedModel.yearFrom}–${selectedModel.yearTo}` : '2020'}
              />
            </Field>
            <Field label="Color">
              <Input
                value={form.color}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                placeholder="Gris"
              />
            </Field>
            <Field label="Vence seguro (opcional)">
              <Input
                type="date"
                value={form.insuranceExpiresAt}
                onChange={(e) => setForm({ ...form, insuranceExpiresAt: e.target.value })}
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
            onClick={() => void submit()}
          >
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Alta de documento ── */
export function CreateDocumentDialog() {
  const create = useCreateDocument();
  const catalog = useCatalog();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    ownerType: 'DRIVER' as 'DRIVER' | 'VEHICLE',
    ownerId: '',
    type: FleetDocumentType.LICENSE_A1 as FleetDocumentType,
    documentNumber: '',
    issuedAt: '',
    expiresAt: '',
  });

  // B5-vert · GATE "oculto hasta vender": al catálogo base le sumamos SOLO las certificaciones que exige
  // una vertical HABILITADA (ambulancia apagada ⇒ su credencial no aparece). Reflejo de UX, no autorización:
  // el backend acepta cualquier FleetDocumentType. Mientras las verticales estén ocultas, el dropdown queda
  // EXACTAMENTE como hoy (solo los 5 docs base).
  const documentTypes = useMemo<FleetDocumentType[]>(
    () => [
      ...DOCUMENT_TYPES,
      ...certificationTypesForEnabledOfferings(catalog.data?.offerings ?? []),
    ],
    [catalog.data],
  );

  const valid = form.ownerId.trim() && form.documentNumber.trim();

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await create.mutateAsync({
        ownerType: form.ownerType,
        ownerId: form.ownerId.trim(),
        type: form.type,
        documentNumber: form.documentNumber.trim(),
        issuedAt: form.issuedAt || undefined,
        expiresAt: form.expiresAt || undefined,
      });
      toast({ tone: 'success', title: 'Documento registrado (pendiente de revisión)' });
      setOpen(false);
      setForm({
        ownerType: 'DRIVER',
        ownerId: '',
        type: FleetDocumentType.LICENSE_A1,
        documentNumber: '',
        issuedAt: '',
        expiresAt: '',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar el documento.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <span>
          <CreateTrigger label="Registrar documento" />
        </span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar documento</DialogTitle>
          <DialogDescription>
            Entra como pendiente de revisión hasta que un operador lo valide.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-1">
          <Field label="Titular">
            <select
              className={selectClass}
              value={form.ownerType}
              onChange={(e) =>
                setForm({ ...form, ownerType: e.target.value as 'DRIVER' | 'VEHICLE' })
              }
            >
              <option value="DRIVER">Conductor</option>
              <option value="VEHICLE">Vehículo</option>
            </select>
          </Field>
          <Field label="Tipo">
            <select
              className={selectClass}
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as FleetDocumentType })}
            >
              {documentTypes.map((t) => (
                <option key={t} value={t}>
                  {documentTypeLabel(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ID del titular">
            <Input
              value={form.ownerId}
              onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              placeholder="uuid del conductor/vehículo"
            />
          </Field>
          <Field label="N° de documento">
            <Input
              value={form.documentNumber}
              onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
            />
          </Field>
          <Field label="Emitido (opcional)">
            <Input
              type="date"
              value={form.issuedAt}
              onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
            />
          </Field>
          <Field label="Vence (opcional)">
            <Input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
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

/* ── Alta de inspección ── */
export function CreateInspectionDialog() {
  const create = useCreateInspection();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ vehicleId: '', passed: 'true', inspectedAt: '', notes: '' });

  const valid = form.vehicleId.trim().length > 0;

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await create.mutateAsync({
        vehicleId: form.vehicleId.trim(),
        passed: form.passed === 'true',
        inspectedAt: form.inspectedAt || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast({ tone: 'success', title: 'Inspección registrada' });
      setOpen(false);
      setForm({ vehicleId: '', passed: 'true', inspectedAt: '', notes: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la inspección.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <span>
          <CreateTrigger label="Registrar inspección" />
        </span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar inspección técnica</DialogTitle>
          <DialogDescription>
            El servidor calcula el próximo vencimiento (BR-D04: trimestral).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <Field label="ID del vehículo">
            <Input
              value={form.vehicleId}
              onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}
              placeholder="uuid del vehículo"
            />
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
