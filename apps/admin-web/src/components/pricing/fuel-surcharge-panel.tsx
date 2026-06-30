'use client';

import { useState } from 'react';
import { Fuel } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { FuelSurchargeView } from '@/lib/api/schemas';
import { useReplaceFuelSurcharge } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Techos de cordura (espejo del DTO server-side, defensa en profundidad UI). */
const MAX_SOLES_PER_LITER = 100;
const MAX_KM_PER_LITER = 200;

/**
 * Recargo de combustible (B4). El admin ingresa lo que VE en el grifo — el PRECIO por litro — y el
 * RENDIMIENTO del vehículo de referencia (km/litro). El sistema DERIVA el recargo por km = precio ÷
 * rendimiento, lo suma a la tarifa por km (FIXED + sugerido de PUJA) y lo escala por oferta. Server-driven:
 * el quote/create del pasajero lo reflejan al instante. La UI solo refleja `pricing:manage`; el admin-bff +
 * trip-service re-autorizan. Precio en SOLES/litro (se persiste en céntimos); rendimiento en km/litro entero.
 *
 * UX — DOS modelos, UNO activo: el recargo de combustible (B4) y el modelo de energía (B5) son mutuamente
 * excluyentes (el flip lo decide la config del sistema, NO este panel). Cuando B5 reemplazó a B4, este panel
 * NO se muestra como un formulario activo (confunde: editable pero sin efecto, y el operador no puede
 * re-activarlo desde acá) → se COLAPSA en un acordeón muteado "modelo anterior". El modelo ACTIVO es el único
 * prominente. (El estado "Vista previa" del panel de energía es distinto: forward-config legítimo, sí editable.)
 */
export function FuelSurchargePanel({ config }: { config: FuelSurchargeView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const { toast } = useToast();
  const replace = useReplaceFuelSurcharge();

  const [priceSoles, setPriceSoles] = useState<string>(
    formatSolesInput(config.fuelPricePerLiterCents),
  );
  const [kmPerLiter, setKmPerLiter] = useState<string>(String(config.kmPerLiter));

  const priceCents = parseSolesInput(priceSoles);
  const km = kmPerLiter.trim() === '' ? 0 : Math.round(Number(kmPerLiter));
  const priceInvalid =
    !Number.isFinite(priceCents) || priceCents < 0 || priceCents > MAX_SOLES_PER_LITER * 100;
  const kmInvalid = !Number.isFinite(km) || km < 0 || km > MAX_KM_PER_LITER;
  const invalid = priceInvalid || kmInvalid;

  // El recargo/km DERIVADO (preview en vivo, misma fórmula que el server: precio ÷ rendimiento).
  const derivedPerKmCents = km > 0 ? Math.round(priceCents / km) : 0;
  const dirty = priceCents !== config.fuelPricePerLiterCents || km !== config.kmPerLiter;

  async function save() {
    try {
      // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409.
      await replace.mutateAsync({
        fuelPricePerLiterCents: priceCents,
        kmPerLiter: km,
        expectedVersion: config.version,
      });
      toast({
        tone: 'success',
        title: `Combustible: S/${formatSolesInput(priceCents)}/L ÷ ${km} km/L → recargo S/${formatSolesInput(derivedPerKmCents)}/km`,
      });
    } catch (err) {
      // 409 = otro admin cambió el config mientras editabas. El hook ya re-sincroniza (onSettled) → el panel
      // muestra los valores vigentes; pedimos revisar y reintentar (NO se pisó nada: degradación honesta).
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'El combustible lo cambió otro admin. Recargamos los valores vigentes — revisá y reintentá.'
          : `No se pudo guardar el combustible${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  // Cuerpo editable (descripción + inputs + preview + versión). El MISMO para ambos estados — la descripción
  // y la etiqueta del derivado ya se ramifican por `config.active`.
  const body = (
    <>
      <p className="mt-1 text-sm text-ink-subtle">
        {config.active
          ? 'Ingresá el precio del combustible (lo que ves en el grifo) y el rendimiento del vehículo de referencia. El sistema deriva el recargo por km = precio ÷ rendimiento y lo aplica a la tarifa (precio fijo y sugerido de puja). El cambio es global, inmediato y queda auditado.'
          : 'Reemplazado por el modelo de precios de energía: lo que edites acá NO afecta la tarifa mientras el modelo de energía esté activo. El cambio de modelo lo decide la configuración del sistema, no este panel.'}
      </p>

      <div className="mt-4 flex max-w-2xl flex-wrap items-end gap-3">
        <Field
          label="Precio del combustible (S/ por litro)"
          hint={`Actual: S/${formatSolesInput(config.fuelPricePerLiterCents)}`}
          error={priceInvalid ? `Entre 0 y ${MAX_SOLES_PER_LITER}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.10"
            min="0"
            max={MAX_SOLES_PER_LITER}
            value={priceSoles}
            onChange={(e) => setPriceSoles(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <Field
          label="Rendimiento (km por litro)"
          hint="Vehículo de referencia; 0 = sin recargo"
          error={kmInvalid ? `Entre 0 y ${MAX_KM_PER_LITER}` : undefined}
        >
          <Input
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            max={MAX_KM_PER_LITER}
            value={kmPerLiter}
            onChange={(e) => setKmPerLiter(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        {canManage ? (
          !dirty || invalid || replace.isPending ? (
            <Button variant="primary" size="md" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title="Confirmar cambio de recargo de combustible"
              description="Esta acción cambia el pricing global y queda auditada."
              trigger={
                <Button variant="primary" size="md">
                  Guardar
                </Button>
              }
              onVerified={save}
            />
          )
        ) : null}
      </div>

      {/* Preview del recargo derivado. El valor PERSISTIDO se etiqueta según el estado: "vigente" SOLO si el
          recargo está activo; si fue reemplazado, "guardado · sin efecto" (no mentir que está en efecto). */}
      <p className="mt-3 text-sm text-ink">
        Recargo derivado:{' '}
        <span className="font-medium text-accent">
          S/{formatSolesInput(derivedPerKmCents)} por km
        </span>{' '}
        <span className="text-ink-subtle">
          {config.active
            ? `(vigente: S/${formatSolesInput(config.perKmCents)}/km)`
            : `(guardado: S/${formatSolesInput(config.perKmCents)}/km · sin efecto hoy)`}
        </span>
      </p>

      {!canManage ? (
        <p className="mt-2 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar el combustible.
        </p>
      ) : null}
    </>
  );

  // REEMPLAZADO → NO se renderiza. Un modelo que no afecta la tarifa es config muerta: mostrar un editor
  // inerte (aunque sea colapsado) confunde al operador. El backend conserva el valor; si el flip revierte
  // (energía → combustible), `active` vuelve a true y el panel reaparece solo. La UI muestra SOLO lo vivo.
  if (!config.active) return null;

  // ACTIVO → panel pleno.
  return (
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Fuel className="size-4" aria-hidden /> Recargo de combustible
        <Badge tone="success">Activo</Badge>
      </h3>
      {body}
    </section>
  );
}
