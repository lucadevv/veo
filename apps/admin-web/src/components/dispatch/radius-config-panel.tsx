'use client';

import { useState } from 'react';
import { Map, Radar, Timer, Gavel } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DispatchRadiusConfigView } from '@/lib/api/schemas';
import {
  K_RING_MAX,
  K_RING_MIN,
  isValidKRing,
  kRingLabel,
  OFFER_TIMEOUT_SEC_MIN,
  OFFER_TIMEOUT_SEC_MAX,
  BID_WINDOW_SEC_MIN,
  BID_WINDOW_SEC_MAX,
  isValidOfferTimeoutSec,
  isValidBidWindowSec,
  msToSec,
  secToMs,
} from '@/lib/dispatch';
import { dateTime } from '@/lib/formatters';
import { useUpdateDispatchRadiusConfig } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';

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
 * Panel de la config de RADIOS (k-rings) + VENTANAS de dispatch. El operador edita los dos radios (1..8)
 * y las dos ventanas de tiempo: la oferta directa (FIXED) y la puja. Ambas ventanas se muestran/editan en
 * SEGUNDOS por legibilidad; la oferta directa se persiste en milisegundos (el contrato guarda ms). El
 * guardado se CONFIRMA (es global y bumpea version aguas abajo) y reemplaza los cuatro valores de una. La
 * UI sólo refleja `dispatch:manage`; el admin-bff + dispatch-service re-autorizan server-side.
 */
export function RadiusConfigPanel({ config }: { config: DispatchRadiusConfigView }) {
  const user = useSession();
  const canManage = can(user, 'dispatch:manage');
  const { toast } = useToast();
  const update = useUpdateDispatchRadiusConfig();

  // Estado del formulario sembrado con la config vigente. Strings para tolerar el input intermedio.
  const [nearby, setNearby] = useState(String(config.nearbyKRing));
  const [match, setMatch] = useState(String(config.matchKRing));
  // Ventanas en SEGUNDOS: la oferta directa llega en ms → se muestra en s (se re-multiplica al guardar).
  const [offerSec, setOfferSec] = useState(String(msToSec(config.offerTimeoutMs)));
  const [bidSec, setBidSec] = useState(String(config.bidWindowSec));

  const values = {
    nearbyKRing: Number(nearby),
    matchKRing: Number(match),
    offerTimeoutSec: Number(offerSec),
    bidWindowSec: Number(bidSec),
  };
  const errors = {
    nearbyKRing: isValidKRing(values.nearbyKRing)
      ? undefined
      : `Debe ser un entero entre ${K_RING_MIN} y ${K_RING_MAX}.`,
    matchKRing: isValidKRing(values.matchKRing)
      ? undefined
      : `Debe ser un entero entre ${K_RING_MIN} y ${K_RING_MAX}.`,
    offerTimeoutSec: isValidOfferTimeoutSec(values.offerTimeoutSec)
      ? undefined
      : `Debe ser un entero entre ${OFFER_TIMEOUT_SEC_MIN} y ${OFFER_TIMEOUT_SEC_MAX} segundos.`,
    bidWindowSec: isValidBidWindowSec(values.bidWindowSec)
      ? undefined
      : `Debe ser un entero entre ${BID_WINDOW_SEC_MIN} y ${BID_WINDOW_SEC_MAX} segundos.`,
  };
  const valid =
    !errors.nearbyKRing && !errors.matchKRing && !errors.offerTimeoutSec && !errors.bidWindowSec;
  const dirty =
    values.nearbyKRing !== config.nearbyKRing ||
    values.matchKRing !== config.matchKRing ||
    secToMs(values.offerTimeoutSec) !== config.offerTimeoutMs ||
    values.bidWindowSec !== config.bidWindowSec;

  const fieldFor = (key: 'nearbyKRing' | 'matchKRing') =>
    key === 'nearbyKRing' ? ([nearby, setNearby] as const) : ([match, setMatch] as const);

  async function save() {
    await update.mutateAsync({
      nearbyKRing: values.nearbyKRing,
      matchKRing: values.matchKRing,
      offerTimeoutMs: secToMs(values.offerTimeoutSec),
      bidWindowSec: values.bidWindowSec,
    });
    toast({ tone: 'success', title: 'Configuración de dispatch actualizada' });
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
                  required={canManage}
                >
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
                  <Icon className="size-3.5" aria-hidden />k = {value || '—'} ·{' '}
                  {isValidKRing(k) ? kRingLabel(k) : '—'}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Ventanas de dispatch</CardTitle>
            <CardDescription>
              Cuánto tiempo espera cada mecánica de match. Una ventana corta cierra antes (más reintentos);
              una larga da más margen al conductor. El cambio aplica en vivo, sin reiniciar el servicio.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Field
              label="Ventana de oferta directa (s)"
              hint="Segundos que tiene el conductor para responder una oferta directa (FIXED) antes de pasar al siguiente."
              error={canManage ? errors.offerTimeoutSec : undefined}
              required={canManage}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={OFFER_TIMEOUT_SEC_MIN}
                max={OFFER_TIMEOUT_SEC_MAX}
                step={1}
                value={offerSec}
                disabled={!canManage || update.isPending}
                onChange={(e) => setOfferSec(e.target.value)}
                aria-label="Ventana de oferta directa (segundos)"
              />
            </Field>
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <Timer className="size-3.5" aria-hidden />
              {isValidOfferTimeoutSec(values.offerTimeoutSec)
                ? `${values.offerTimeoutSec} s por oferta`
                : '—'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Field
              label="Ventana de puja (s)"
              hint="Segundos que un tablero de puja queda abierto para que los conductores oferten."
              error={canManage ? errors.bidWindowSec : undefined}
              required={canManage}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={BID_WINDOW_SEC_MIN}
                max={BID_WINDOW_SEC_MAX}
                step={1}
                value={bidSec}
                disabled={!canManage || update.isPending}
                onChange={(e) => setBidSec(e.target.value)}
                aria-label="Ventana de puja (segundos)"
              />
            </Field>
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <Gavel className="size-3.5" aria-hidden />
              {isValidBidWindowSec(values.bidWindowSec) ? `${values.bidWindowSec} s por tablero` : '—'}
            </p>
          </div>
        </CardContent>
      </Card>

      <section>
        <h2 className="text-sm font-medium text-ink-muted">Referencia de cobertura (H3 res-9)</h2>
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border px-4 py-3 text-sm sm:grid-cols-4">
          {Array.from({ length: K_RING_MAX - K_RING_MIN + 1 }, (_, i) => K_RING_MIN + i).map(
            (k) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="text-ink">k={k}</span>
                <span className="tabular text-ink-muted">{kRingLabel(k)}</span>
              </li>
            ),
          )}
        </ul>
      </section>

      <div className="flex items-center gap-3">
        {canManage ? (
          !valid || !dirty || update.isPending ? (
            <Button type="button" disabled loading={update.isPending}>
              Guardar configuración
            </Button>
          ) : (
            <StepUpDialog
              trigger={<Button type="button">Guardar configuración</Button>}
              title="Actualizar configuración de dispatch"
              description={`El feed de mapa pasará a k=${values.nearbyKRing} (${kRingLabel(
                values.nearbyKRing,
              )}) y las pujas a k=${values.matchKRing} (${kRingLabel(
                values.matchKRing,
              )}). Las ventanas serán ${values.offerTimeoutSec}s (oferta directa) y ${values.bidWindowSec}s (puja). Esta acción cambia el despacho global y queda auditada.`}
              onVerified={save}
            />
          )
        ) : (
          <p className="text-xs text-ink-subtle">
            Solo lectura: necesitas el rol DISPATCHER, ADMIN o SUPERADMIN para cambiar la configuración.
          </p>
        )}
      </div>

      <p className="text-xs text-ink-subtle">
        Versión {config.version}
        {/* version 0 = config por defecto nunca editada: el backend manda `updatedAt` epoch (no null), así que
            NO se puede confiar en la truthiness de updatedAt — gateamos por version (igual que cost-per-km). */}
        {config.version > 0
          ? ` · actualizado ${dateTime(config.updatedAt)}`
          : ' · valor por defecto (sin editar)'}
      </p>
    </div>
  );
}
