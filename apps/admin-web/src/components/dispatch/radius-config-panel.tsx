'use client';

import { useMemo, useState } from 'react';
import type {
  DispatchRadiusConfigView,
  FixedPolicy,
  PujaPolicy,
} from '@/lib/api/schemas';
import {
  useCarpoolSearchConfig,
  useCarpoolRadar,
  useDispatchRadar,
  useUpdateDispatchRadiusConfig,
  useUpdateCarpoolSearchConfig,
} from '@/lib/api/queries';
import { dateTime } from '@/lib/formatters';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { DispatchRadar } from './dispatch-radar';

/** Centro de medición del radar (Lima centro). El backend degrada honesto si no hay flota. */
const LIMA = { lat: -12.0464, lon: -77.0428 };

/** Defaults del motor v2 cuando la config aún es v1 (policyV2 null): valores sanos = los del board. */
const FIXED_DEFAULTS: FixedPolicy = {
  initialRadiusKm: 0.6,
  incrementKm: 0.3,
  maxRadiusKm: 1.5,
  targetDrivers: 3,
  offerTimeoutSec: 20,
  expandIntervalSec: 8,
};
const PUJA_DEFAULTS: PujaPolicy = { broadcastRadiusKm: 1.2, bidWindowSec: 60 };

const km = (n: number) => `${n.toFixed(1)} km`;
const sec = (n: number) => `${n} s`;

/**
 * Panel de RADIOS de dispatch — 3 modos REALES (Fijo/Puja/Carpool), fiel al frame BemzL pero cada modo con sus
 * palancas de verdad (el board ponía "Programado", que es un eje de tiempo, no un modo). Fijo/Puja viven en el
 * motor de dispatch (policy v2 sobre H3, feature-flag); Carpool es booking-service (BlaBlaCar cost-share). El
 * radar es EXACTO: densidad real del hot-index por anillo. Guardar exige step-up (cambia el matching en vivo) +
 * activa v2. La UI solo refleja `dispatch:manage`; admin-bff + los servicios re-autorizan.
 */
export function RadiusConfigPanel({ config }: { config: DispatchRadiusConfigView }) {
  const user = useSession();
  const canManage = can(user, 'dispatch:manage');
  const { toast } = useToast();

  const updateDispatch = useUpdateDispatchRadiusConfig();
  const updateCarpool = useUpdateCarpoolSearchConfig();
  const carpoolQuery = useCarpoolSearchConfig();

  // Estado de formulario sembrado de la config vigente (o defaults v2 si aún es v1 / carpool cargando).
  const [fixed, setFixed] = useState<FixedPolicy>(config.policyV2?.FIXED ?? FIXED_DEFAULTS);
  const [puja, setPuja] = useState<PujaPolicy>(config.policyV2?.PUJA ?? PUJA_DEFAULTS);
  const [carpoolBase, setCarpoolBase] = useState<number | null>(null);
  const [carpoolExpand, setCarpoolExpand] = useState<number | null>(null);

  const carpool = carpoolQuery.data;
  const base = carpoolBase ?? carpool?.baseRadiusKm ?? 0.3;
  const expand = carpoolExpand ?? carpool?.expandRadiusKm ?? 0.6;

  const dispatchDirty =
    JSON.stringify(fixed) !== JSON.stringify(config.policyV2?.FIXED ?? FIXED_DEFAULTS) ||
    JSON.stringify(puja) !== JSON.stringify(config.policyV2?.PUJA ?? PUJA_DEFAULTS) ||
    config.policyVersion !== 'v2';
  const carpoolDirty =
    carpool != null && (base !== carpool.baseRadiusKm || expand !== carpool.expandRadiusKm);
  const dirty = dispatchDirty || carpoolDirty;

  async function save() {
    const jobs: Promise<unknown>[] = [];
    if (dispatchDirty) {
      jobs.push(
        updateDispatch.mutateAsync({
          nearbyKRing: config.nearbyKRing,
          matchKRing: config.matchKRing,
          offerTimeoutMs: config.offerTimeoutMs,
          bidWindowSec: config.bidWindowSec,
          policyVersion: 'v2',
          policyV2: { FIXED: fixed, PUJA: puja },
        }),
      );
    }
    if (carpoolDirty) {
      jobs.push(updateCarpool.mutateAsync({ baseRadiusKm: base, expandRadiusKm: expand }));
    }
    await Promise.all(jobs);
    toast({ tone: 'success', title: 'Configuración de radios guardada' });
  }

  const pending = updateDispatch.isPending || updateCarpool.isPending;

  return (
    <div className="stagger flex flex-col gap-5">
      <Tabs defaultValue="FIXED">
        <TabsList>
          <TabsTrigger value="FIXED">Fijo</TabsTrigger>
          <TabsTrigger value="PUJA">Puja</TabsTrigger>
          <TabsTrigger value="CARPOOL">Carpool</TabsTrigger>
        </TabsList>

        {/* ── FIJO ── */}
        <TabsContent value="FIXED">
          <ModeLayout
            title="Parámetros de radio · Fijo"
            radar={
              <RadarPanel
                mode="FIXED"
                maxRadiusKm={fixed.maxRadiusKm}
                note="Oferta secuencial: expande el radio hasta juntar los conductores objetivo, ofreciendo de a uno."
              />
            }
          >
            <Slider
              label="Radio inicial"
              hint="La búsqueda arranca en este radio."
              displayValue={km(fixed.initialRadiusKm)}
              value={fixed.initialRadiusKm}
              min={0.3}
              max={2.4}
              step={0.1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, initialRadiusKm: v }))}
            />
            <Slider
              label="Incremento por expansión"
              hint="Cuánto crece el radio en cada paso."
              displayValue={km(fixed.incrementKm)}
              value={fixed.incrementKm}
              min={0.1}
              max={1.0}
              step={0.1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, incrementKm: v }))}
            />
            <Slider
              label="Radio máximo"
              hint="Tope al que puede llegar la búsqueda (límite H3 ≈ 2.4 km)."
              displayValue={km(fixed.maxRadiusKm)}
              value={fixed.maxRadiusKm}
              min={0.3}
              max={2.4}
              step={0.1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, maxRadiusKm: v }))}
            />
            <Slider
              label="Conductores objetivo"
              hint="Expande hasta tener al menos esta cantidad de candidatos en rango."
              displayValue={String(fixed.targetDrivers)}
              value={fixed.targetDrivers}
              min={1}
              max={20}
              step={1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, targetDrivers: v }))}
            />
            <Slider
              label="Tiempo de oferta"
              hint="Segundos que tiene el conductor para aceptar una oferta directa."
              displayValue={sec(fixed.offerTimeoutSec)}
              value={fixed.offerTimeoutSec}
              min={5}
              max={120}
              step={1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, offerTimeoutSec: v }))}
            />
            <Slider
              label="Intervalo de expansión"
              hint="Tiempo de espera entre expansiones del radio."
              displayValue={sec(fixed.expandIntervalSec)}
              value={fixed.expandIntervalSec}
              min={2}
              max={60}
              step={1}
              disabled={!canManage || pending}
              onChange={(v) => setFixed((f) => ({ ...f, expandIntervalSec: v }))}
            />
          </ModeLayout>
        </TabsContent>

        {/* ── PUJA ── */}
        <TabsContent value="PUJA">
          <ModeLayout
            title="Parámetros de radio · Puja"
            radar={
              <RadarPanel
                mode="PUJA"
                maxRadiusKm={puja.broadcastRadiusKm}
                note="Broadcast de una sola vez: la solicitud se difunde al disco y los conductores pujan dentro de la ventana."
              />
            }
          >
            <Slider
              label="Radio de broadcast"
              hint="Hasta dónde se difunde la solicitud para que los conductores pujen."
              displayValue={km(puja.broadcastRadiusKm)}
              value={puja.broadcastRadiusKm}
              min={0.3}
              max={2.4}
              step={0.1}
              disabled={!canManage || pending}
              onChange={(v) => setPuja((p) => ({ ...p, broadcastRadiusKm: v }))}
            />
            <Slider
              label="Ventana de puja"
              hint="Segundos que el tablero queda abierto para que los conductores oferten."
              displayValue={sec(puja.bidWindowSec)}
              value={puja.bidWindowSec}
              min={15}
              max={300}
              step={5}
              disabled={!canManage || pending}
              onChange={(v) => setPuja((p) => ({ ...p, bidWindowSec: v }))}
            />
          </ModeLayout>
        </TabsContent>

        {/* ── CARPOOL ── */}
        <TabsContent value="CARPOOL">
          {carpoolQuery.isLoading ? (
            <div className="grid gap-5 lg:grid-cols-[1fr_440px]">
              <Skeleton className="h-64 rounded-[20px]" />
              <Skeleton className="h-64 rounded-[20px]" />
            </div>
          ) : (
            <ModeLayout
              title="Parámetros de radio · Carpool"
              radar={
                <CarpoolRadarPanel
                  maxRadiusKm={expand}
                  note="Producto de costo compartido (booking-service): el conductor publica una ruta y los pasajeros cercanos se suman."
                />
              }
            >
              <Slider
                label="Radio base"
                hint="Anillo de búsqueda inicial de rutas de carpool publicadas."
                displayValue={km(base)}
                value={base}
                min={0.0}
                max={1.5}
                step={0.1}
                disabled={!canManage || pending}
                onChange={setCarpoolBase}
              />
              <Slider
                label="Radio expandido"
                hint="Si la búsqueda base no encuentra rutas, expande a este radio."
                displayValue={km(expand)}
                value={expand}
                min={0.3}
                max={2.4}
                step={0.1}
                disabled={!canManage || pending}
                onChange={setCarpoolExpand}
              />
            </ModeLayout>
          )}
        </TabsContent>
      </Tabs>

      {/* Footer de guardado */}
      <div className="flex items-center justify-between gap-4 border-t border-divider pt-4">
        <p className="text-xs text-ink-subtle">
          Dispatch v{config.version}
          {config.version > 0 ? ` · ${dateTime(config.updatedAt)}` : ' · valor por defecto'} · motor{' '}
          <span className={config.policyVersion === 'v2' ? 'text-success' : 'text-ink-muted'}>
            {config.policyVersion}
          </span>
        </p>
        {canManage ? (
          !dirty || pending ? (
            <button
              type="button"
              disabled
              className="rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-accent-on opacity-50"
            >
              {pending ? 'Guardando…' : 'Guardar cambios'}
            </button>
          ) : (
            <StepUpDialog
              title="¿Aplicar nueva config?"
              description="El cambio afecta el matching de conductores en tiempo real y se aplica de inmediato a todos los servicios. Queda auditado."
              confirmLabel="Aplicar cambios"
              confirmVariant="primary"
              onVerified={save}
              trigger={
                <button
                  type="button"
                  className="rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-accent-on shadow-brand transition-colors hover:bg-accent-hover"
                >
                  Guardar cambios
                </button>
              }
            />
          )
        ) : (
          <p className="text-xs text-ink-subtle">
            Solo lectura: necesitás DISPATCHER, ADMIN o SUPERADMIN para cambiar los radios.
          </p>
        )}
      </div>
    </div>
  );
}

/** Layout de un modo: card de sliders (izq) + card de radar (der), fiel al board (2 columnas). */
function ModeLayout({
  title,
  children,
  radar,
}: {
  title: string;
  children: React.ReactNode;
  radar: React.ReactNode;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_440px] lg:items-start">
      <section className="flex flex-col gap-5 rounded-[20px] border border-black/[0.05] bg-surface p-6 shadow-3">
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        {children}
      </section>
      <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-6 shadow-3">
        <h2 className="font-display text-base font-semibold text-ink">Vista previa</h2>
        {radar}
      </section>
    </div>
  );
}

/** Radar de un modo de dispatch (Fijo/Puja) — densidad real del hot-index. */
function RadarPanel({
  mode,
  maxRadiusKm,
  note,
}: {
  mode: 'FIXED' | 'PUJA';
  maxRadiusKm: number;
  note: string;
}) {
  const [center, setCenter] = useState(LIMA);
  const radar = useDispatchRadar(mode, center);
  return (
    <>
      <DispatchRadar
        preview={radar.data}
        center={center}
        maxRadiusKm={maxRadiusKm}
        loading={radar.isLoading}
        error={radar.isError}
        onRetry={() => void radar.refetch()}
        onRecenter={setCenter}
      />
      <p className="text-[11px] leading-relaxed text-ink-subtle">{note}</p>
    </>
  );
}

/** Radar de carpool (booking-service) — densidad real de rutas publicadas. */
function CarpoolRadarPanel({ maxRadiusKm, note }: { maxRadiusKm: number; note: string }) {
  const [center, setCenter] = useState(LIMA);
  const radar = useCarpoolRadar(center);
  return (
    <>
      <DispatchRadar
        preview={radar.data}
        center={center}
        maxRadiusKm={maxRadiusKm}
        loading={radar.isLoading}
        error={radar.isError}
        onRetry={() => void radar.refetch()}
        onRecenter={setCenter}
      />
      <p className="text-[11px] leading-relaxed text-ink-subtle">{note}</p>
    </>
  );
}
