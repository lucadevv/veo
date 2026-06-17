'use client';

import { useState } from 'react';
import { Zap } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { EnergyCatalogView } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useReplaceEnergyCatalog } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Techo de cordura (espejo del DTO server-side): S/100 por unidad. */
const MAX_PER_UNIT = 100;

/** Etiqueta legible de la unidad de energía (display, no comparación de dominio). */
const UNIT_LABEL: Record<string, string> = { LITER: 'S/ por litro', KWH: 'S/ por kWh' };

/** Nombre legible de la fuente (display; el server valida el enum). */
const SOURCE_LABEL: Record<string, string> = {
  GASOLINE_95: 'Gasolina 95',
  GASOLINE_84: 'Gasolina 84',
  DIESEL: 'Diésel',
  GNV: 'GNV',
  ELECTRIC: 'Eléctrico',
};

/**
 * Catálogo de precios de energía (B5). El admin ingresa el PRECIO por unidad de cada fuente (lo que ve en
 * el grifo / la tarifa de kWh); el sistema deriva el costo por km = precio ÷ rendimiento de cada oferta y
 * lo aplica a la tarifa (server-driven). Hoy MVP: solo Gasolina 95 (el resto de fuentes se desbloquean con
 * las verticales eléctricas/diésel). La UI solo refleja `pricing:manage`; admin-bff + trip-service re-autorizan.
 */
export function EnergyCatalogPanel({ config }: { config: EnergyCatalogView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const { toast } = useToast();
  const replace = useReplaceEnergyCatalog();

  // Estado editable: precio en SOLES por fuente (se persiste en céntimos). Clave = sourceId.
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      config.sources.map((s) => [s.sourceId, (s.pricePerUnitCents / 100).toFixed(2)]),
    ),
  );

  const centsOf = (sourceId: string): number => {
    const raw = prices[sourceId]?.trim();
    return raw === '' || raw === undefined ? 0 : Math.round(Number(raw) * 100);
  };
  const invalidOf = (sourceId: string): boolean => {
    const c = centsOf(sourceId);
    return !Number.isFinite(c) || c < 0 || c > MAX_PER_UNIT * 100;
  };

  const anyInvalid = config.sources.some((s) => invalidOf(s.sourceId));
  const dirty = config.sources.some((s) => centsOf(s.sourceId) !== s.pricePerUnitCents);

  async function save() {
    try {
      await replace.mutateAsync({
        sources: config.sources.map((s) => ({
          sourceId: s.sourceId,
          pricePerUnitCents: centsOf(s.sourceId),
        })),
        expectedVersion: config.version,
      });
      toast({ tone: 'success', title: 'Precios de energía actualizados' });
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'Los precios de energía los cambió otro admin. Recargamos lo vigente — revisá y reintentá.'
          : `No se pudieron guardar los precios${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <section className="pt-6">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Zap className="size-4" aria-hidden /> Precios de energía
      </h2>
      <p className="mt-1 text-sm text-ink-subtle">
        Ingresá el precio de cada fuente de energía (lo que ves en el grifo o la tarifa de kWh). El
        sistema deriva el recargo por km de cada servicio según su rendimiento. El cambio es global
        y queda auditado.
      </p>

      {config.sources.length === 0 ? (
        <p className="mt-3 text-sm text-ink-subtle">Sin fuentes de energía configuradas todavía.</p>
      ) : (
        <div className="mt-4 flex max-w-2xl flex-wrap items-end gap-3">
          {config.sources.map((s) => (
            <Field
              key={s.sourceId}
              label={`${SOURCE_LABEL[s.sourceId] ?? s.sourceId} (${UNIT_LABEL[s.unit] ?? s.unit})`}
              hint={`Actual: S/${(s.pricePerUnitCents / 100).toFixed(2)}`}
              error={invalidOf(s.sourceId) ? `Entre 0 y ${MAX_PER_UNIT}` : undefined}
            >
              <Input
                type="number"
                inputMode="decimal"
                step="0.10"
                min="0"
                max={MAX_PER_UNIT}
                value={prices[s.sourceId] ?? ''}
                onChange={(e) => setPrices((p) => ({ ...p, [s.sourceId]: e.target.value }))}
                disabled={!canManage}
              />
            </Field>
          ))}

          {canManage ? (
            !dirty || anyInvalid || replace.isPending ? (
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
                onVerified={save}
              />
            )
          ) : null}
        </div>
      )}

      {!canManage ? (
        <p className="mt-2 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar los precios de energía.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-ink-subtle">
        Versión {config.version}
        {config.updatedAt ? ` · actualizado ${dateTime(config.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </section>
  );
}
