'use client';

import { useState } from 'react';
import { Route } from 'lucide-react';
import type { CostPerKmConfigView, CostPerKmListView } from '@/lib/api/schemas';
import { useReplaceCostPerKm } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';

/** Tope de cordura del costo/km (espejo del DTO server-side, defensa en profundidad UI): S/0.01 .. S/100/km. */
const MIN_CENTS = 1;
const MAX_CENTS = 10_000;

/** Etiqueta legible del país. */
const PAIS_LABEL: Record<string, string> = { PE: 'Perú (PEN)', EC: 'Ecuador (USD→PEN ref.)' };

/** Fila editable de UN país (cada país versiona su tarifa por separado · CAS independiente). */
function CountryRow({ config }: { config: CostPerKmConfigView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const replace = useReplaceCostPerKm();
  const { save, saving } = useConfigSave({
    mutation: replace,
    // El sustantivo del conflicto lleva el país (cada país versiona su tarifa por separado · CAS independiente).
    conflictNoun: `el costo/km de ${config.pais}`,
    error: 'No se pudo guardar el costo/km',
    success: (p) => `Costo/km ${p.pais}: S/${formatSolesInput(p.costPerKmCents)}`,
  });

  const [soles, setSoles] = useState<string>(formatSolesInput(config.costPerKmCents));

  const cents = parseSolesInput(soles);
  const invalid = !Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS;
  const dirty = cents !== config.costPerKmCents;

  // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409 y
  // useConfigSave muestra el toast de conflicto (el onSettled de la mutation re-sincroniza el valor vigente).
  const onSave = () =>
    save({ pais: config.pais, costPerKmCents: cents, expectedVersion: config.version });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        label={`${PAIS_LABEL[config.pais] ?? config.pais} — S/ por km`}
        hint={`Actual: S/${formatSolesInput(config.costPerKmCents)}/km`}
        error={invalid ? `Entre S/${formatSolesInput(MIN_CENTS)} y S/${formatSolesInput(MAX_CENTS)}` : undefined}
      >
        <Input
          type="number"
          inputMode="decimal"
          // step de 1 céntimo: el piso es S/0.01 (min), así que con step=0.10 el browser marcaba stepMismatch
          // (`:invalid`) para valores legítimos como 1.50/0.50 — no caen en la grilla 0.01+0.10·n. El costo/km
          // es dinero en céntimos: 0.01 es la granularidad natural y alinea min↔step (sin falso `invalid`).
          step="0.01"
          min={formatSolesInput(MIN_CENTS)}
          max={formatSolesInput(MAX_CENTS)}
          value={soles}
          onChange={(e) => setSoles(e.target.value)}
          disabled={!canManage}
        />
      </Field>

      <SaveAction
        canManage={canManage}
        dirty={dirty}
        invalid={invalid}
        saving={saving}
        onSave={onSave}
        title={`Confirmar costo/km de ${config.pais}`}
        description="Esta acción cambia el costo de operación por km que limita el precio del carpooling (escudo legal anti-lucro) y queda auditada."
      />
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

      <ReadOnlyNote canManage={canManage} noun="el costo/km" className="mt-3" />
    </section>
  );
}
