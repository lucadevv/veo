'use client';

import { useState } from 'react';
import { Gavel } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import { OFFERING_LIST, PricingMode, GLOBAL_ZONE } from '@veo/shared-types';
import type { BidFloorView } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { offeringLabel } from '@/lib/catalog';
import { useReplaceBidFloor } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Techo de cordura (espejo del DTO server-side BID_FLOOR_MAX_CENTS, defensa en profundidad UI). S/1000. */
const MAX_SOLES = 1000;

/** Las ofertas a las que aplica el piso: solo las que PERMITEN PUJA (las FIXED-only no pujan). */
const PUJA_OFFERINGS = OFFERING_LIST.filter((o) => o.allowedModes.includes(PricingMode.PUJA));

/** Céntimos → soles string (para el input); '' si es null/0 sin override. */
function centsToSoles(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Piso de la PUJA per-oferta (ADR 010 §9.3). El admin fija un piso por DEFECTO (céntimos PEN) + overrides
 * POR OFERTA (ej. moto S/3 < confort S/9). El piso es el mínimo que un pasajero puede ofertar en modo PUJA;
 * trip-service lo aplica como gate AUTORITATIVO en createTrip/rebid y el quote lo MUESTRA por oferta — el
 * MISMO resolver (consistencia por construcción). Per-zona queda zone-ready (hoy zona única GLOBAL).
 * Server-driven: la UI solo refleja `pricing:manage`; admin-bff + trip-service re-autorizan (step-up MFA).
 */
export function BidFloorPanel({ config }: { config: BidFloorView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const { toast } = useToast();
  const replace = useReplaceBidFloor();

  // Piso por defecto (soles) + overrides por oferta (soles; '' = sin override → usa el default).
  const [defaultSoles, setDefaultSoles] = useState<string>(centsToSoles(config.defaultFloorCents));
  const initialOverrides: Record<string, string> = {};
  for (const ov of config.overrides) {
    if (ov.zone === GLOBAL_ZONE) initialOverrides[ov.offeringId] = centsToSoles(ov.floorCents);
  }
  const [overrideSoles, setOverrideSoles] = useState<Record<string, string>>(initialOverrides);

  const defaultCents = defaultSoles.trim() === '' ? 0 : Math.round(Number(defaultSoles) * 100);
  const defaultInvalid = !Number.isFinite(defaultCents) || defaultCents < 1 || defaultCents > MAX_SOLES * 100;

  // Overrides EFECTIVOS: las filas con valor numérico válido > 0 (vacío = sin override → cae al default).
  const overrides = PUJA_OFFERINGS.flatMap((o) => {
    const raw = overrideSoles[o.id]?.trim() ?? '';
    if (raw === '') return [];
    const cents = Math.round(Number(raw) * 100);
    return [{ offeringId: o.id, cents, valid: Number.isFinite(cents) && cents >= 1 && cents <= MAX_SOLES * 100 }];
  });
  const anyOverrideInvalid = overrides.some((o) => !o.valid);
  const invalid = defaultInvalid || anyOverrideInvalid;

  async function save() {
    try {
      await replace.mutateAsync({
        defaultFloorCents: defaultCents,
        // expectedVersion = la que cargamos (CAS): si otro admin la movió, el server responde 409.
        overrides: overrides.map((o) => ({ zone: GLOBAL_ZONE, offeringId: o.offeringId, floorCents: o.cents })),
        expectedVersion: config.version,
      });
      toast({
        tone: 'success',
        title: `Piso de puja guardado: default S/${centsToSoles(defaultCents)} · ${overrides.length} override(s) por oferta`,
      });
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'El piso lo cambió otro admin. Recargamos los valores vigentes — revisá y reintentá.'
          : `No se pudo guardar el piso${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <section className="pt-6">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Gavel className="size-4" aria-hidden /> Piso de la puja (por oferta)
      </h2>
      <p className="mt-1 text-sm text-ink-subtle">
        El mínimo que un pasajero puede ofertar en modo PUJA. Definí un piso por defecto y, opcionalmente, un
        piso distinto por oferta (ej. moto más bajo que confort). Dejá una oferta vacía para que use el
        default. El cambio es inmediato, server-side y queda auditado.
      </p>

      <div className="mt-4 max-w-2xl space-y-3">
        <Field
          label="Piso por defecto (S/)"
          hint={`Actual: S/${centsToSoles(config.defaultFloorCents)}`}
          error={defaultInvalid ? `Entre 1 y ${MAX_SOLES}` : undefined}>
          <Input
            type="number"
            inputMode="decimal"
            step="0.50"
            min="1"
            max={MAX_SOLES}
            value={defaultSoles}
            onChange={(e) => setDefaultSoles(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <div className="rounded-lg border border-line/60 p-3">
          <p className="text-xs font-medium text-ink-muted">Overrides por oferta (vacío = usa el default)</p>
          <div className="mt-2 grid gap-2">
            {PUJA_OFFERINGS.map((o) => {
              const val = overrideSoles[o.id] ?? '';
              const cents = val.trim() === '' ? 0 : Math.round(Number(val) * 100);
              const rowInvalid =
                val.trim() !== '' && (!Number.isFinite(cents) || cents < 1 || cents > MAX_SOLES * 100);
              return (
                <Field
                  key={o.id}
                  label={offeringLabel(o.id)}
                  error={rowInvalid ? `Entre 1 y ${MAX_SOLES}` : undefined}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.50"
                    min="1"
                    max={MAX_SOLES}
                    placeholder={`default S/${centsToSoles(defaultCents || config.defaultFloorCents)}`}
                    value={val}
                    onChange={(e) => setOverrideSoles((prev) => ({ ...prev, [o.id]: e.target.value }))}
                    disabled={!canManage}
                  />
                </Field>
              );
            })}
          </div>
        </div>

        {canManage ? (
          invalid || replace.isPending ? (
            <Button variant="primary" size="md" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title="Confirmar cambio del piso de la puja"
              description="Esta acción cambia el pricing (piso mínimo de oferta) y queda auditada."
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

      {!canManage ? (
        <p className="mt-2 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar el piso de la puja.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-ink-subtle">
        Versión {config.version}
        {config.updatedAt && config.version > 0 ? ` · actualizado ${dateTime(config.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </section>
  );
}
