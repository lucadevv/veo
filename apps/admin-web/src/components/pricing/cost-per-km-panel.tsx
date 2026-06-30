'use client';

import { useState } from 'react';
import { Route } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { CostPerKmConfigView, CostPerKmListView } from '@/lib/api/schemas';
import { useReplaceCostPerKm } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Tope de cordura del costo/km (espejo del DTO server-side, defensa en profundidad UI): S/0.01 .. S/100/km. */
const MIN_CENTS = 1;
const MAX_CENTS = 10_000;

/** Etiqueta legible del país. */
const PAIS_LABEL: Record<string, string> = { PE: 'Perú (PEN)', EC: 'Ecuador (USD→PEN ref.)' };

/** céntimos Int → soles para mostrar (150 → "1.50"). */
function centsToSoles(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** soles (string del input) → céntimos Int (dinero SIEMPRE Int, nunca float persistido). Vacío = 0. */
function solesToCents(soles: string): number {
  return soles.trim() === '' ? 0 : Math.round(Number(soles) * 100);
}

/** Fila editable de UN país (cada país versiona su tarifa por separado · CAS independiente). */
function CountryRow({ config }: { config: CostPerKmConfigView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const { toast } = useToast();
  const replace = useReplaceCostPerKm();

  const [soles, setSoles] = useState<string>(centsToSoles(config.costPerKmCents));

  const cents = solesToCents(soles);
  const invalid = !Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS;
  const dirty = cents !== config.costPerKmCents;

  async function save() {
    try {
      // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409.
      await replace.mutateAsync({
        pais: config.pais,
        costPerKmCents: cents,
        expectedVersion: config.version,
      });
      toast({ tone: 'success', title: `Costo/km ${config.pais}: S/${centsToSoles(cents)}` });
    } catch (err) {
      // 409 = otro admin cambió el config mientras editabas. El hook re-sincroniza (onSettled) → el panel
      // muestra el valor vigente; pedimos revisar y reintentar (NO se pisó nada: degradación honesta).
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? `El costo/km de ${config.pais} lo cambió otro admin. Recargamos el valor vigente — revisá y reintentá.`
          : `No se pudo guardar el costo/km${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        label={`${PAIS_LABEL[config.pais] ?? config.pais} — S/ por km`}
        hint={`Actual: S/${centsToSoles(config.costPerKmCents)}/km`}
        error={invalid ? `Entre S/${centsToSoles(MIN_CENTS)} y S/${centsToSoles(MAX_CENTS)}` : undefined}
      >
        <Input
          type="number"
          inputMode="decimal"
          // step de 1 céntimo: el piso es S/0.01 (min), así que con step=0.10 el browser marcaba stepMismatch
          // (`:invalid`) para valores legítimos como 1.50/0.50 — no caen en la grilla 0.01+0.10·n. El costo/km
          // es dinero en céntimos: 0.01 es la granularidad natural y alinea min↔step (sin falso `invalid`).
          step="0.01"
          min={centsToSoles(MIN_CENTS)}
          max={centsToSoles(MAX_CENTS)}
          value={soles}
          onChange={(e) => setSoles(e.target.value)}
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
            title={`Confirmar costo/km de ${config.pais}`}
            description="Esta acción cambia el costo de operación por km que limita el precio del carpooling (escudo legal anti-lucro) y queda auditada."
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
  );
}

/**
 * Costo de OPERACIÓN por km del carpooling (F2.5 · escudo legal anti-lucro). El admin fija, por país, el costo
 * real de operar el vehículo (combustible + desgaste, estilo "IRS mileage rate"). Ese costo/km alimenta DIRECTO
 * el tope de cost-sharing: precio del asiento ≤ (distancia_km × costo/km + peaje) / asientos. NO se deriva del
 * precio de energía. El peaje lo declara el conductor por viaje (no se configura acá). La UI solo refleja
 * `finance:manage`; el admin-bff + booking-service re-autorizan y auditan. El costo se persiste en céntimos Int.
 */
export function CostPerKmPanel({ config }: { config: CostPerKmListView }) {
  const canManage = can(useSession(), 'finance:manage');
  return (
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Route className="size-4" aria-hidden /> Costo de operación por km (carpooling)
      </h3>
      <p className="mt-1 text-sm text-ink-subtle">
        El costo real de operar el vehículo por km (combustible + desgaste). Limita el precio del carpooling:
        el asiento no puede pasar de <strong>(distancia × costo/km + peaje) ÷ asientos</strong>. El peaje lo
        declara el conductor por viaje.
      </p>

      <div className="mt-4 grid max-w-3xl gap-5 sm:grid-cols-2">
        {config.configs.map((c) => (
          <CountryRow key={c.pais} config={c} />
        ))}
      </div>

      {!canManage ? (
        <p className="mt-3 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar el costo/km.
        </p>
      ) : null}
    </section>
  );
}
