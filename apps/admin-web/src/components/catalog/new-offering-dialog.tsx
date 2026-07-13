'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PricingMode, ServiceType, VehicleClass } from '@veo/shared-types';
import { solesToCents } from '@veo/utils/money';
import { useCreateOffering } from '@/lib/api/queries';
import { useToast } from '@/components/ui/toast';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Field } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { StepUpDialog } from '@/components/security/step-up-dialog';
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

/** Espejo del MULTIPLIER_MAX autoritativo (trip-service catalog.dto). trip-service + admin-bff RE-validan. */
const MULTIPLIER_MAX_UI = 10;

const VEHICLE_CLASS_LABEL: Record<VehicleClass, string> = {
  [VehicleClass.CAR]: 'Auto',
  [VehicleClass.MOTO]: 'Moto',
};
const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  [ServiceType.RIDE]: 'Viaje',
  [ServiceType.AMBULANCE]: 'Ambulancia',
  [ServiceType.TOW]: 'Grúa',
  [ServiceType.MECHANIC]: 'Mecánico',
};
const MODE_LABEL: Record<PricingMode, string> = {
  [PricingMode.FIXED]: 'Precio fijo',
  [PricingMode.PUJA]: 'Puja',
};

/**
 * Alta de una oferta CUSTOM (ADR 013 · board "Nuevo servicio" kmbzI/ZC3fO). El botón que lo dispara SOLO se
 * muestra al SUPERADMIN (los call-sites gatean con `can(user, 'catalog:create')`); el admin-bff + trip-service
 * RE-autorizan server-side (@Roles(SUPERADMIN) + step-up MFA) — la UI solo refleja el gate.
 *
 * El form usa las primitivas del Trust UI Kit (Select/Input/Switch/Button brand). Restricción HONESTA reflejada
 * en la UI: la clase de vehículo y la vertical se ELIGEN de las EXISTENTES (no hay campo libre) — una custom
 * mapea a un vehicleClass/serviceType que ya existe (el dispatch trabaja por vehicleClass). El guardado pide
 * step-up TOTP (reusa StepUpDialog). Al crear, el `onSettled` del hook refetchea el catálogo → la card aparece.
 */
export function NewOfferingDialog({
  triggerVariant = 'primary',
  triggerSize = 'md',
  triggerClassName,
}: {
  triggerVariant?: ButtonProps['variant'];
  triggerSize?: ButtonProps['size'];
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [vehicleClass, setVehicleClass] = useState<VehicleClass>(VehicleClass.CAR);
  const [serviceType, setServiceType] = useState<ServiceType>(ServiceType.RIDE);
  const [mode, setMode] = useState<PricingMode>(PricingMode.FIXED);
  const [multiplier, setMultiplier] = useState('1.0');
  const [minFareSoles, setMinFareSoles] = useState('5.00');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateOffering();
  const { toast } = useToast();

  const nameTrim = name.trim();
  const multNum = Number(multiplier);
  const minFareCents = minFareSoles.trim() === '' ? NaN : solesToCents(Number(minFareSoles));
  const nameInvalid = nameTrim.length < 2;
  const multInvalid = !Number.isFinite(multNum) || multNum <= 0 || multNum > MULTIPLIER_MAX_UI;
  const minFareInvalid = !Number.isFinite(minFareCents) || minFareCents < 0;
  const invalid = nameInvalid || multInvalid || minFareInvalid;

  function reset(): void {
    setName('');
    setVehicleClass(VehicleClass.CAR);
    setServiceType(ServiceType.RIDE);
    setMode(PricingMode.FIXED);
    setMultiplier('1.0');
    setMinFareSoles('5.00');
    setEnabled(true);
    setError(null);
  }

  async function submit(): Promise<void> {
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: nameTrim,
        vehicleClass,
        serviceType,
        mode,
        multiplier: multNum,
        minFareCents,
        enabled,
      });
      toast({ tone: 'success', title: `${created.name ?? created.labelKey} creada` });
      setOpen(false);
      reset();
    } catch (e) {
      // El error queda VISIBLE en el form (no se pierde tras cerrar): 403 de rol/step-up, 400 de validación, etc.
      setError(e instanceof Error ? e.message : 'No se pudo crear el servicio.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize} className={triggerClassName}>
          <Plus className="size-4" aria-hidden />
          Nuevo servicio
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo servicio</DialogTitle>
          <DialogDescription>
            Creá una oferta a medida. Se mapea a una clase de vehículo y una vertical EXISTENTES — el
            despacho y el pricing la tratan igual que a las demás.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label="Nombre"
            required
            error={!nameInvalid || name.length === 0 ? undefined : 'Mínimo 2 caracteres'}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VEO Playa"
              maxLength={40}
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Clase de vehículo" hint="Pool de matching existente.">
              <Select
                value={vehicleClass}
                onChange={(e) => setVehicleClass(e.target.value as VehicleClass)}
              >
                {Object.values(VehicleClass).map((v) => (
                  <option key={v} value={v}>
                    {VEHICLE_CLASS_LABEL[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tipo de servicio" hint="Vertical existente.">
              <Select
                value={serviceType}
                onChange={(e) => setServiceType(e.target.value as ServiceType)}
              >
                {Object.values(ServiceType).map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_TYPE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Modo de pricing">
              <Select value={mode} onChange={(e) => setMode(e.target.value as PricingMode)}>
                {Object.values(PricingMode).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Multiplicador"
              error={multInvalid && multiplier.trim() !== '' ? `0 < x ≤ ${MULTIPLIER_MAX_UI}` : undefined}
            >
              <Input
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                max={MULTIPLIER_MAX_UI}
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Tarifa mínima (S/)"
            error={minFareInvalid && minFareSoles.trim() !== '' ? 'Debe ser ≥ 0' : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.50"
              min="0"
              value={minFareSoles}
              onChange={(e) => setMinFareSoles(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium text-ink-muted">Habilitada al crear</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} label="Habilitada al crear" />
          </div>

          {error ? (
            <Alert tone="danger" title="No se pudo crear el servicio">
              {error}
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          {/* El guardado es acción sensible (SUPERADMIN) → step-up TOTP. En dev el StepUpDialog lo omite
              (espejo del guard del backend) y corre `submit` directo. */}
          <StepUpDialog
            title="Crear servicio"
            description="Estás creando una oferta de servicio nueva. Ingresá tu código TOTP para confirmar."
            confirmLabel="Crear servicio"
            onVerified={submit}
            trigger={
              <Button variant="primary" disabled={invalid || create.isPending} loading={create.isPending}>
                Crear servicio
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
