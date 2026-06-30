'use client';

import { useState } from 'react';
import { Zap } from 'lucide-react';
import type { EnergyCatalogView } from '@/lib/api/schemas';
import { useReplaceEnergyCatalog } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Techo de cordura (espejo del DTO server-side): S/100 por unidad. */
const MAX_PER_UNIT = 100;

/** Etiqueta legible de la unidad (display). */
const UNIT_LABEL: Record<string, string> = { LITER: 'S/ por litro', KWH: 'S/ por kWh' };

/**
 * Los 3 TIPOS de energía de ADR-017 (UN precio por tipo, sin octanaje). Lista canónica que espeja el
 * enum `EnergySource` del contrato — la fuente de verdad de qué se puede configurar (no lo que ya está
 * sembrado). La gasolina es UNA (referencia 90, la común); el octanaje real del conductor no importa.
 * GNV/GLP NO son tipos de plataforma (combustible privado del conductor, no se trackea).
 * `note` marca las verticales cuyas ofertas aún están OCULTAS: configurables hacia adelante, sin efecto hoy.
 */
const ENERGY_TYPES = [
  { id: 'GASOLINE_90', label: 'Gasolina 90', unit: 'LITER', note: undefined },
  { id: 'DIESEL', label: 'Diésel', unit: 'LITER', note: 'Se aplica cuando la vertical de diésel esté activa.' },
  { id: 'ELECTRIC', label: 'Eléctrico', unit: 'KWH', note: 'Se aplica cuando la vertical eléctrica esté activa.' },
] as const;

/**
 * Catálogo de precios de energía (B5 · ADR-017 §1.1). El admin ingresa UN precio por TIPO (lo que ve en el
 * grifo / la tarifa de kWh); el sistema deriva el costo por km = precio ÷ rendimiento de cada oferta. Hoy la
 * gasolina-90 es la única con efecto (las otras 2 son verticales cuyas ofertas están ocultas → forward-config).
 * La UI solo refleja `pricing:manage`; admin-bff + trip-service re-autorizan. El cambio es global y auditado.
 */
export function EnergyCatalogPanel({ config }: { config: EnergyCatalogView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const replace = useReplaceEnergyCatalog();
  const { save, saving } = useConfigSave({
    mutation: replace,
    success: 'Precios de energía actualizados',
    conflictNoun: 'los precios de energía',
    error: 'No se pudieron guardar los precios',
  });

  /** Precio vigente (céntimos) de un tipo, leído del catálogo persistido (0 si aún no se configuró). */
  const persistedCents = (id: string): number =>
    config.sources.find((s) => s.sourceId === id)?.pricePerUnitCents ?? 0;

  // Estado editable: precio en SOLES por tipo. Arranca de lo persistido (0 = sin configurar todavía).
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(ENERGY_TYPES.map((t) => [t.id, formatSolesInput(persistedCents(t.id))])),
  );

  const centsOf = (id: string): number => parseSolesInput(prices[id] ?? '');
  const invalidOf = (id: string): boolean => {
    const c = centsOf(id);
    return !Number.isFinite(c) || c < 0 || c > MAX_PER_UNIT * 100;
  };

  const anyInvalid = ENERGY_TYPES.some((t) => invalidOf(t.id));
  const dirty = ENERGY_TYPES.some((t) => centsOf(t.id) !== persistedCents(t.id));

  // Persistimos los 3 tipos (sourceId + precio); el server revalida el enum y el techo. expectedVersion = CAS.
  const onSave = () =>
    save({
      sources: ENERGY_TYPES.map((t) => ({ sourceId: t.id, pricePerUnitCents: centsOf(t.id) })),
      expectedVersion: config.version,
    });

  return (
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Zap className="size-4" aria-hidden /> Precios de energía
        {config.active ? (
          <Badge tone="success">Activo</Badge>
        ) : (
          <Badge tone="neutral">Vista previa</Badge>
        )}
      </h3>
      <p className="mt-1 text-sm text-ink-subtle">
        {config.active
          ? 'Un precio por tipo de energía (grifo o kWh). El sistema deriva el recargo por km de cada servicio según su rendimiento.'
          : 'Un precio por tipo de energía (grifo o kWh). Todavía no afecta la tarifa: lo que edites queda guardado para cuando se active el modelo de energía.'}
      </p>

      <div className="mt-4 flex max-w-2xl flex-wrap items-start gap-3">
        {ENERGY_TYPES.map((t) => (
          <Field
            key={t.id}
            label={`${t.label} (${UNIT_LABEL[t.unit] ?? t.unit})`}
            hint={t.note ?? `Actual: S/${formatSolesInput(persistedCents(t.id))}`}
            error={invalidOf(t.id) ? `Entre 0 y ${MAX_PER_UNIT}` : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.10"
              min="0"
              max={MAX_PER_UNIT}
              value={prices[t.id] ?? ''}
              onChange={(e) => setPrices((p) => ({ ...p, [t.id]: e.target.value }))}
              disabled={!canManage}
            />
          </Field>
        ))}

        {canManage ? (
          !dirty || anyInvalid || saving ? (
            <Button variant="primary" size="md" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title="Confirmar cambio de precios de energía"
              description="Esta acción cambia el pricing global y queda auditada."
              trigger={
                <Button variant="primary" size="md">
                  Guardar
                </Button>
              }
              onVerified={onSave}
            />
          )
        ) : null}
      </div>

      {!canManage ? (
        <p className="mt-2 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar los precios de energía.
        </p>
      ) : null}
    </section>
  );
}
