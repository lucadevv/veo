'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlarmClock,
  ArrowDownWideNarrow,
  ArrowRight,
  Boxes,
  CalendarClock,
  Car,
  ChevronLeft,
  ChevronRight,
  FileText,
  Lock,
  Search,
  Timer,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  useDriversPending,
  useExpiringDocuments,
  useFleetDocuments,
  useModelReview,
  useReviewsSummary,
  useVehicles,
} from '@/lib/api/queries';
import type { PendingDriver, VehicleView } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { downloadCsv } from '@/lib/csv';
import { date as fmtDate } from '@/lib/formatters';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ModelReviewActions } from '@/components/fleet/model-review-actions';

type QueueType = 'conductor' | 'vehiculo' | 'documento';

interface QueueRow {
  key: string;
  type: QueueType;
  itemA: string;
  itemAMono: boolean;
  itemB: string;
  pendiente: string;
  enqueuedAt: string | null;
  href: string;
}

const DOC_STATUS = { VALID: 'VALID', EXPIRING_SOON: 'EXPIRING_SOON', EXPIRED: 'EXPIRED' } as const;

const DOC_LABEL: Record<string, string> = {
  SOAT: 'SOAT',
  DNI: 'DNI',
  LICENSE_A1: 'Licencia',
  PROPERTY_CARD: 'Tarjeta de propiedad',
  VEHICLE_PHOTO: 'Foto del vehículo',
  ITV: 'ITV',
};

/** Espera en cola formateada ("3d 4h" / "22 h") + tono por umbral SLA (>48h danger, 24-48h warn, <24h neutro). */
function waitParts(iso: string | null): { label: string; tone: SlaTone } {
  if (!iso) return { label: '—', tone: 'neutral' };
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return { label: '—', tone: 'neutral' };
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  const label = d >= 1 ? `${d}d ${h - d * 24}h` : `${h} h`;
  const tone: SlaTone = h > 48 ? 'danger' : h >= 24 ? 'warn' : 'neutral';
  return { label, tone };
}

type SlaTone = 'danger' | 'warn' | 'neutral';
const SLA_TEXT: Record<SlaTone, string> = {
  danger: 'text-danger',
  warn: 'text-warn',
  neutral: 'text-ink-muted',
};

/** Tono del vencimiento por días restantes (≤0 vencido → danger, ≤7 → warn, resto neutro). Análogo a waitParts. */
function expiryTone(days: number): SlaTone {
  return days <= 0 ? 'danger' : days <= 7 ? 'warn' : 'neutral';
}

/** "Pendiente" derivado de un conductor pendiente (docs incompletos + verificación biométrica). */
function driverPending(d: PendingDriver): string {
  const missing = Math.max(0, d.docsTotal - d.docsComplete);
  const needsBio = d.verificationStatus !== null && d.verificationStatus !== 'VERIFICADO';
  if (needsBio && missing > 0)
    return `Biométrico + ${missing} documento${missing === 1 ? '' : 's'}`;
  if (missing > 0) return `${missing} documento${missing === 1 ? '' : 's'} por revisar`;
  if (needsBio) return 'Verificación biométrica';
  return 'Revisión de alta';
}

/** "Pendiente" derivado de un vehículo en revisión (ITV + estado documental). */
function vehiclePending(v: VehicleView): string {
  const parts: string[] = [];
  if (v.itvHasInspection && !v.itvCurrent) parts.push('ITV vencida');
  if (v.status === DOC_STATUS.EXPIRED) parts.push('documentos vencidos');
  else if (v.status === DOC_STATUS.EXPIRING_SOON) parts.push('documentos por vencer');
  if (parts.length === 0 && !v.operable) parts.push('revisión de aptitud');
  return parts.join(' + ') || 'Revisión de documentos';
}

function vehicleNeedsReview(v: VehicleView): boolean {
  return (
    !v.operable ||
    v.status === DOC_STATUS.EXPIRED ||
    v.status === DOC_STATUS.EXPIRING_SOON ||
    (v.itvHasInspection && !v.itvCurrent)
  );
}

const TYPE_META: Record<QueueType, { icon: LucideIcon; label: string; cls: string }> = {
  conductor: { icon: User, label: 'Conductor', cls: 'bg-accent/15 text-accent' },
  vehiculo: { icon: Car, label: 'Vehículo', cls: 'bg-surface-2 text-ink-muted' },
  documento: { icon: FileText, label: 'Documento', cls: 'bg-warn/15 text-warn' },
};

type Tab = 'todos' | 'conductor' | 'vehiculo' | 'documento' | 'modelo' | 'vencer' | 'sla';
const TABS: { key: Tab; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'conductor', label: 'Conductores' },
  { key: 'vehiculo', label: 'Vehículos' },
  { key: 'documento', label: 'Documentos' },
  { key: 'modelo', label: 'Modelos' },
  { key: 'vencer', label: 'Por vencer' },
  { key: 'sla', label: 'SLA vencido' },
];

const GRID = 'grid grid-cols-[120px_1fr_210px_110px_120px] items-center gap-4';
// Cola de modelos: forma distinta a la unificada (make/model/años/tipo/asientos + 2 acciones).
const MODEL_GRID = 'grid grid-cols-[1fr_130px_130px_90px_130px_190px] items-center gap-4';
// Cola de vencimientos: forma propia (tipo/dueño/vence/restan + acción "Ver").
const EXPIRING_GRID = 'grid grid-cols-[150px_1fr_150px_130px_110px] items-center gap-4';

export default function ReviewsPage() {
  const user = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('todos');
  const [search, setSearch] = useState('');

  const drivers = useDriversPending();
  const documents = useFleetDocuments('PENDING_REVIEW');
  const vehicles = useVehicles();
  // Conteos AUTORITATIVOS de la cola (server-side, /ops/reviews/summary): no dependen de las páginas ya
  // cargadas en el cliente (que sub-cuentan). Alimentan las stat cards de Conductores y Documentos.
  const summary = useReviewsSummary();
  // Cola de modelos pendientes de aprobar (B5-2.c). Estado del dominio = 'PENDING_REVIEW' (enum
  // vehicleModelStatus). Se muestra en su propia pestaña con tabla y acciones dedicadas.
  const models = useModelReview('PENDING_REVIEW');
  const modelRows = useMemo(() => models.data?.pages.flatMap((p) => p.items) ?? [], [models.data]);
  // Cola de documentos próximos a vencer (SOAT/DNI/ITV…). Su propia pestaña con tabla y acción de salto
  // al detalle del dueño (conductor o vehículo). Paginado por cursor en el servidor (fleet-service).
  const expiring = useExpiringDocuments();
  const expiringRows = useMemo(
    () => expiring.data?.pages.flatMap((p) => p.items) ?? [],
    [expiring.data],
  );

  const rows = useMemo<QueueRow[]>(() => {
    const out: QueueRow[] = [];
    for (const d of drivers.data ?? []) {
      out.push({
        key: `c_${d.id}`,
        type: 'conductor',
        itemA: d.fullName ?? `drv_${d.id.slice(0, 8)}`,
        itemAMono: d.fullName === null,
        itemB: `drv_${d.id.slice(0, 8)} · alta`,
        pendiente: driverPending(d),
        enqueuedAt: d.enqueuedAt,
        href: `/ops/drivers/${d.id}`,
      });
    }
    const docItems = documents.data?.pages.flatMap((p) => p.items) ?? [];
    for (const doc of docItems.filter((x) => x.ownerType === 'DRIVER')) {
      out.push({
        key: `d_${doc.id}`,
        type: 'documento',
        itemA: `${DOC_LABEL[doc.type] ?? doc.type} reenviado`,
        itemAMono: false,
        itemB: `drv_${doc.ownerId.slice(0, 8)}`,
        pendiente: `${DOC_LABEL[doc.type] ?? doc.type} reenviado a revisión`,
        enqueuedAt: doc.createdAt,
        href: `/ops/drivers/${doc.ownerId}`,
      });
    }
    const vehItems = vehicles.data?.pages.flatMap((p) => p.items) ?? [];
    for (const v of vehItems.filter(vehicleNeedsReview)) {
      out.push({
        key: `v_${v.id}`,
        type: 'vehiculo',
        itemA: v.plate,
        itemAMono: true,
        itemB: `${[v.brand, v.model].filter(Boolean).join(' ')}${v.year ? ` · ${v.year}` : ''}`,
        pendiente: vehiclePending(v),
        enqueuedAt: v.createdAt,
        href: `/fleet/${v.id}`,
      });
    }
    // Orden fijo del frame: "Más antiguos primero" (encolado ascendente; sin fecha al final).
    out.sort((a, b) => {
      const ta = a.enqueuedAt ? new Date(a.enqueuedAt).getTime() : Infinity;
      const tb = b.enqueuedAt ? new Date(b.enqueuedAt).getTime() : Infinity;
      return ta - tb;
    });
    return out;
  }, [drivers.data, documents.data, vehicles.data]);

  const counts = useMemo(() => {
    const slaBreached = rows.filter((r) => waitParts(r.enqueuedAt).tone === 'danger').length;
    return {
      total: rows.length,
      conductor: rows.filter((r) => r.type === 'conductor').length,
      vehiculo: rows.filter((r) => r.type === 'vehiculo').length,
      documento: rows.filter((r) => r.type === 'documento').length,
      sla: slaBreached,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const byTab = rows.filter((r) => {
      if (tab === 'todos') return true;
      if (tab === 'sla') return waitParts(r.enqueuedAt).tone === 'danger';
      return r.type === tab;
    });
    const q = search.trim().toLowerCase();
    return q
      ? byTab.filter(
          (r) =>
            r.itemA.toLowerCase().includes(q) ||
            r.itemB.toLowerCase().includes(q) ||
            r.pendiente.toLowerCase().includes(q),
        )
      : byTab;
  }, [rows, tab, search]);

  const loading = drivers.isLoading || documents.isLoading || vehicles.isLoading;
  const errored = drivers.isError || documents.isError || vehicles.isError;

  // Paginación client-side sobre la cola ya merged/ordenada/filtrada (8/página como el frame). Real: prev/next
  // recorren el set. Vuelve a página 1 al cambiar de tab o búsqueda (si no, quedaría en una página inexistente).
  const PAGE_SIZE = 8;
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [tab, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  const exportCsv = () =>
    downloadCsv(
      'veo-revisiones.csv',
      ['Tipo', 'Ítem', 'Detalle', 'Pendiente', 'Esperando'],
      filtered.map((r) => [
        TYPE_META[r.type].label,
        r.itemA,
        r.itemB,
        r.pendiente,
        waitParts(r.enqueuedAt).label,
      ]),
    );

  if (!can(user, 'fleet:review')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">
          Necesitás el rol de revisión de flota para ver la cola.
        </p>
      </div>
    );
  }

  const tabCount = (k: Tab): number | undefined =>
    k === 'todos'
      ? counts.total
      : k === 'sla'
        ? counts.sla
        : k === 'conductor'
          ? counts.conductor
          : k === 'vehiculo'
            ? counts.vehiculo
            : k === 'modelo'
              ? (summary.data?.modelsPendingReview ?? modelRows.length)
              : k === 'vencer'
                ? (summary.data?.docsExpiringSoon ?? expiringRows.length)
                : counts.documento;

  return (
    <div className="flex min-h-full flex-col gap-[22px] px-8 py-7">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Revisiones</h1>
          <p className="text-[13px] text-ink-subtle">
            Cola unificada de aprobación · conductores, vehículos y documentos · ordenada por espera
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center rounded-full border border-border-strong bg-surface px-[18px] py-[11px] text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          Exportar cola
        </button>
      </div>

      {/* Stat cards · Conductores y Documentos son AUTORITATIVOS (server: /ops/reviews/summary), no del set
          paginado. Vehículos y SLA se derivan de la cola cargada (el summary no los cubre hoy). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard
          icon={Users}
          label="Conductores"
          value={summary.data ? String(summary.data.driversPending) : '—'}
          hint="Altas por revisar"
          hintTone="brand"
          loading={summary.isLoading}
        />
        <StatCard
          icon={FileText}
          label="Documentos"
          value={summary.data ? String(summary.data.docsPendingReview) : '—'}
          hint="Reenviados a revisión"
          hintTone="brand"
          loading={summary.isLoading}
        />
        <StatCard
          icon={Car}
          label="Vehículos"
          value={String(counts.vehiculo)}
          hint="Docs + ITV"
          hintTone="brand"
          loading={loading}
        />
        <button
          type="button"
          onClick={() => setTab('vencer')}
          className="rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <StatCard
            icon={CalendarClock}
            label="Por vencer"
            value={summary.data ? String(summary.data.docsExpiringSoon) : '—'}
            hint="Docs próximos a vencer"
            hintTone="warn"
            loading={summary.isLoading}
          />
        </button>
        <StatCard
          icon={Boxes}
          label="Modelos"
          value={summary.data ? String(summary.data.modelsPendingReview) : '—'}
          hint="Solicitudes por aprobar"
          hintTone="brand"
          loading={summary.isLoading}
        />
        <StatCard
          icon={AlarmClock}
          label="SLA vencido"
          value={String(counts.sla)}
          hint="Esperando > 48 h"
          hintTone="danger"
          loading={loading}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex gap-[3px] rounded-md border border-border bg-surface p-1">
          {TABS.map(({ key, label }) => {
            const active = tab === key;
            const n = tabCount(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-[7px] text-[13px] font-semibold transition-colors ${
                  active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {label}
                <span
                  className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-bold ${
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-ink-subtle'
                  }`}
                >
                  {n ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-3 py-2 text-xs font-semibold text-ink-muted">
            <ArrowDownWideNarrow className="size-3.5" aria-hidden />
            Más antiguos primero
          </span>
          <div className="inline-flex w-[240px] items-center gap-2 rounded-sm border border-border bg-bg px-3 py-[9px]">
            <Search className="size-4 shrink-0 text-ink-subtle" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar en la cola…"
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
        </div>
      </div>

      {/* Cola de modelos (forma propia) vs. cola unificada (conductor/vehículo/documento). */}
      {tab === 'modelo' ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div
            className={`${MODEL_GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
          >
            <span>Modelo</span>
            <span>Años</span>
            <span>Tipo</span>
            <span>Asientos</span>
            <span>Solicitado</span>
            <span />
          </div>

          {models.isError ? (
            <ErrorState className="py-10" onRetry={() => void models.refetch()} />
          ) : models.isLoading ? (
            <div>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[52px] animate-pulse border-b border-border bg-surface-2/40"
                />
              ))}
            </div>
          ) : modelRows.length === 0 ? (
            <EmptyState
              className="py-12"
              title="Sin solicitudes"
              description="No hay solicitudes de modelo esperando aprobación."
            />
          ) : (
            modelRows.map((m) => (
              <div
                key={m.id}
                className={`${MODEL_GRID} border-b border-border px-5 py-3 last:border-b-0`}
              >
                <span className="truncate text-sm font-semibold text-ink">
                  {m.make} {m.model}
                </span>
                <span className="font-mono text-[13px] text-ink-muted">
                  {m.yearFrom}–{m.yearTo}
                </span>
                <span className="truncate text-[13px] text-ink-muted">{m.vehicleType}</span>
                <span className="font-mono text-[13px] text-ink-muted">{m.seats}</span>
                <span className="truncate text-[13px] text-ink-muted">{fmtDate(m.createdAt)}</span>
                <ModelReviewActions model={m} />
              </div>
            ))
          )}
        </div>
      ) : tab === 'vencer' ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div
            className={`${EXPIRING_GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
          >
            <span>Tipo</span>
            <span>Dueño</span>
            <span>Vence</span>
            <span>Restan</span>
            <span />
          </div>

          {expiring.isError ? (
            <ErrorState className="py-10" onRetry={() => void expiring.refetch()} />
          ) : expiring.isLoading ? (
            <div>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[52px] animate-pulse border-b border-border bg-surface-2/40"
                />
              ))}
            </div>
          ) : expiringRows.length === 0 ? (
            <EmptyState
              className="py-12"
              title="Nada por vencer"
              description="No hay documentos próximos a vencer."
            />
          ) : (
            expiringRows.map((d) => {
              const owner = d.ownerType === 'VEHICLE' ? TYPE_META.vehiculo : TYPE_META.conductor;
              const mono = `${d.ownerType === 'VEHICLE' ? 'veh' : 'drv'}_${d.ownerId.slice(0, 8)}`;
              const tone = expiryTone(d.daysUntilExpiry);
              const href =
                d.ownerType === 'VEHICLE' ? `/fleet/${d.ownerId}` : `/ops/drivers/${d.ownerId}`;
              return (
                <div
                  key={d.id}
                  className={`${EXPIRING_GRID} border-b border-border px-5 py-3 last:border-b-0`}
                >
                  <span className="truncate text-sm font-semibold text-ink">
                    {DOC_LABEL[d.type] ?? d.type}
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] text-xs font-semibold ${owner.cls}`}
                    >
                      <owner.icon className="size-[13px]" aria-hidden />
                      {owner.label}
                    </span>
                    <span className="truncate font-mono text-[11px] text-ink-subtle">{mono}</span>
                  </div>
                  <span className="truncate text-[13px] text-ink-muted">{fmtDate(d.expiresAt)}</span>
                  <span
                    className={`inline-flex items-center gap-1.5 font-mono text-[13px] font-semibold ${SLA_TEXT[tone]}`}
                  >
                    <CalendarClock className="size-[13px]" aria-hidden />
                    {d.daysUntilExpiry <= 0 ? 'vencido' : `${d.daysUntilExpiry} días`}
                  </span>
                  <button
                    type="button"
                    onClick={() => router.push(href)}
                    className="inline-flex w-fit items-center gap-1.5 justify-self-end rounded-full border border-accent bg-accent/15 px-3.5 py-2 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/20"
                  >
                    Ver
                    <ArrowRight className="size-[13px]" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <>
          {/* Tabla unificada */}
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <div
              className={`${GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
            >
              <span>Tipo</span>
              <span>Ítem</span>
              <span>Pendiente</span>
              <span>Esperando</span>
              <span />
            </div>

            {errored ? (
              <ErrorState className="py-10" onRetry={() => void drivers.refetch()} />
            ) : loading ? (
              <div>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[52px] animate-pulse border-b border-border bg-surface-2/40"
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                className="py-12"
                title="Cola vacía"
                description="No hay nada esperando revisión en esta vista."
              />
            ) : (
              pageRows.map((r) => {
                const tm = TYPE_META[r.type];
                const w = waitParts(r.enqueuedAt);
                return (
                  <div
                    key={r.key}
                    className={`${GRID} border-b border-border px-5 py-3 last:border-b-0`}
                  >
                    <span
                      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-[5px] text-xs font-semibold ${tm.cls}`}
                    >
                      <tm.icon className="size-[13px]" aria-hidden />
                      {tm.label}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className={`truncate text-sm font-semibold text-ink ${r.itemAMono ? 'font-mono' : ''}`}
                      >
                        {r.itemA}
                      </span>
                      <span className="truncate font-mono text-[11px] text-ink-subtle">
                        {r.itemB}
                      </span>
                    </div>
                    <span className="truncate text-[13px] text-ink-muted">{r.pendiente}</span>
                    <span
                      className={`inline-flex items-center gap-1.5 font-mono text-[13px] font-semibold ${SLA_TEXT[w.tone]}`}
                    >
                      <Timer className="size-[13px]" aria-hidden />
                      {w.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => router.push(r.href)}
                      className="inline-flex w-fit items-center gap-1.5 justify-self-end rounded-full border border-accent bg-accent/15 px-3.5 py-2 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/20"
                    >
                      Revisar
                      <ArrowRight className="size-[13px]" aria-hidden />
                    </button>
                  </div>
                );
              })
            )}

            <div className="flex items-center justify-between border-t border-border bg-surface-2 px-5 py-3">
              <span className="text-[13px] text-ink-subtle">
                {`Mostrando ${pageRows.length} de ${filtered.length} en la cola`}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={clampedPage === 0}
                  aria-label="Página anterior"
                  className="grid size-[34px] place-items-center rounded-sm border border-border bg-surface text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-surface"
                >
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
                <span className="text-[13px] text-ink-muted">{`Página ${clampedPage + 1} de ${totalPages}`}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={clampedPage >= totalPages - 1}
                  aria-label="Página siguiente"
                  className="grid size-[34px] place-items-center rounded-sm border border-border bg-surface text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-surface"
                >
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
