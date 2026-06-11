'use client';

import { useState } from 'react';
import { Map, Radar } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DispatchRadiusConfigView } from '@/lib/api/schemas';
import { K_RING_MAX, K_RING_MIN, isValidKRing, kRingLabel } from '@/lib/dispatch';
import { dateTime } from '@/lib/formatters';
import { useUpdateDispatchRadiusConfig } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** Metadatos de presentación de cada k-ring editable. El contrato sólo tiene dos radios. */
const RINGS: readonly {
  key: 'nearbyKRing' | 'matchKRing';
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    key: 'nearbyKRing',
    label: 'Radio del feed de mapa',
    description: 'Hasta dónde se muestran los conductores cercanos en el mapa del pasajero.',
    icon: Map,
  },
  {
    key: 'matchKRing',
    label: 'Radio de pujas / matching',
    description: 'Hasta dónde se difunde una solicitud para que los conductores pujen.',
    icon: Radar,
  },
];

/**
 * Panel de la config de RADIOS (k-rings) de dispatch. El operador edita dos enteros (1..8); al lado de
 * cada uno mostramos el radio aproximado en metros para que razone en distancia, no en anillos H3. El
 * guardado se CONFIRMA (es global y bumpea version aguas abajo). La UI sólo refleja `dispatch:manage`;
 * el admin-bff + dispatch-service re-autorizan server-side.
 */
export function RadiusConfigPanel({ config }: { config: DispatchRadiusConfigView }) {
  const user = useSession();
  const canManage = can(user, 'dispatch:manage');
  const { toast } = useToast();
  const update = useUpdateDispatchRadiusConfig();

  // Estado del formulario sembrado con la config vigente. Strings para tolerar el input intermedio.
  const [nearby, setNearby] = useState(String(config.nearbyKRing));
  const [match, setMatch] = useState(String(config.matchKRing));

  const values = { nearbyKRing: Number(nearby), matchKRing: Number(match) };
  const errors = {
    nearbyKRing: isValidKRing(values.nearbyKRing)
      ? undefined
      : `Debe ser un entero entre ${K_RING_MIN} y ${K_RING_MAX}.`,
    matchKRing: isValidKRing(values.matchKRing)
      ? undefined
      : `Debe ser un entero entre ${K_RING_MIN} y ${K_RING_MAX}.`,
  };
  const valid = !errors.nearbyKRing && !errors.matchKRing;
  const dirty = values.nearbyKRing !== config.nearbyKRing || values.matchKRing !== config.matchKRing;

  const fieldFor = (key: 'nearbyKRing' | 'matchKRing') =>
    key === 'nearbyKRing'
      ? ([nearby, setNearby] as const)
      : ([match, setMatch] as const);

  async function save() {
    await update.mutateAsync({ nearbyKRing: values.nearbyKRing, matchKRing: values.matchKRing });
    toast({ tone: 'success', title: 'Radios de dispatch actualizados' });
  }

  return (
    <div className="flex flex-col gap-6 pt-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Radios de dispatch</CardTitle>
            <CardDescription>
              Cada radio se mide en anillos H3 (k-ring). A mayor k, mayor cobertura: más conductores
              alcanzados, pero también más ruido y carga.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          {RINGS.map(({ key, label, description, icon: Icon }) => {
            const [value, setValue] = fieldFor(key);
            const k = Number(value);
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <Field
                  label={label}
                  hint={description}
                  error={canManage ? errors[key] : undefined}
                  required={canManage}>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={K_RING_MIN}
                    max={K_RING_MAX}
                    step={1}
                    value={value}
                    disabled={!canManage || update.isPending}
                    onChange={(e) => setValue(e.target.value)}
                    aria-label={`${label} (k-ring)`}
                  />
                </Field>
                <p className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Icon className="size-3.5" aria-hidden />
                  k = {value || '—'} · {isValidKRing(k) ? kRingLabel(k) : '—'}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <section>
        <h2 className="text-sm font-medium text-ink-muted">Referencia de cobertura (H3 res-9)</h2>
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border px-4 py-3 text-sm sm:grid-cols-4">
          {Array.from({ length: K_RING_MAX - K_RING_MIN + 1 }, (_, i) => K_RING_MIN + i).map((k) => (
            <li key={k} className="flex items-center justify-between gap-2">
              <span className="text-ink">k={k}</span>
              <span className="tabular text-ink-muted">{kRingLabel(k)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex items-center gap-3">
        {canManage ? (
          <ConfirmDialog
            trigger={
              <Button type="button" disabled={!valid || !dirty || update.isPending} loading={update.isPending}>
                Guardar radios
              </Button>
            }
            title="Actualizar radios de dispatch"
            description={`El feed de mapa pasará a k=${values.nearbyKRing} (${kRingLabel(
              values.nearbyKRing,
            )}) y las pujas a k=${values.matchKRing} (${kRingLabel(
              values.matchKRing,
            )}). Afecta a TODO el despacho nuevo y queda auditado.`}
            confirmLabel="Actualizar radios"
            onConfirm={save}
          />
        ) : (
          <p className="text-xs text-ink-subtle">
            Solo lectura: necesitas el rol DISPATCHER, ADMIN o SUPERADMIN para cambiar los radios.
          </p>
        )}
      </div>

      <p className="text-xs text-ink-subtle">
        Versión {config.version}
        {config.updatedAt ? ` · actualizado ${dateTime(config.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </div>
  );
}
