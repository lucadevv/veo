'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlarmClock,
  ArrowDownWideNarrow,
  ArrowRight,
  Car,
  ChevronLeft,
  ChevronRight,
  FileText,
  Inbox,
  Lock,
  Search,
  Timer,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useDriversPending, useFleetDocuments, useVehicles } from '@/lib/api/queries';
import type { PendingDriver, VehicleView } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState, ErrorState } from '@/components/ui/states';

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

/** "Pendiente" derivado de un conductor pendiente (docs incompletos + verificación biométrica). */
function driverPending(d: PendingDriver): string {
  const missing = Math.max(0, d.docsTotal - d.docsComplete);
  const needsBio = d.verificationStatus !== null && d.verificationStatus !== 'VERIFICADO';
  if (needsBio && missing > 0) return `Biométrico + ${missing} documento${missing === 1 ? '' : 's'}`;
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

type Tab = 'todos' | 'conductor' | 'vehiculo' | 'documento' | 'sla';
const TABS: { key: Tab; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'conductor', label: 'Conductores' },
  { key: 'vehiculo', label: 'Vehículos' },
  { key: 'documento', label: 'Documentos' },
  { key: 'sla', label: 'SLA vencido' },
];

const GRID = 'grid grid-cols-[120px_1fr_210px_110px_120px] items-center gap-4';

export default function ReviewsPage() {
  const user = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('todos');
  const [search, setSearch] = useState('');

  const drivers = useDriversPending();
  const documents = useFleetDocuments('PENDING_REVIEW');
  const vehicles = useVehicles();

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

  if (!can(user, 'fleet:review')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">Necesitás el rol de revisión de flota para ver la cola.</p>
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
            : counts.documento;

  return (
    <div className="flex h-full min-h-0 flex-col gap-[22px] overflow-auto px-8 py-7">
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
          className="inline-flex items-center rounded-full border border-border-strong bg-surface px-[18px] py-[11px] text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          Exportar cola
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Inbox} label="Pendientes total" value={String(counts.total)} hint="En la cola" loading={loading} />
        <StatCard icon={Users} label="Conductores" value={String(counts.conductor)} hint="Revisión de alta" hintTone="brand" loading={loading} />
        <StatCard icon={Car} label="Vehículos" value={String(counts.vehiculo)} hint="Docs + ITV" hintTone="brand" loading={loading} />
        <StatCard icon={AlarmClock} label="SLA vencido" value={String(counts.sla)} hint="Esperando > 48 h" hintTone="danger" loading={loading} />
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

      {/* Tabla unificada */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className={`${GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}>
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
              <div key={i} className="h-[52px] animate-pulse border-b border-border bg-surface-2/40" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState className="py-12" title="Cola vacía" description="No hay nada esperando revisión en esta vista." />
        ) : (
          filtered.map((r) => {
            const tm = TYPE_META[r.type];
            const w = waitParts(r.enqueuedAt);
            return (
              <div key={r.key} className={`${GRID} border-b border-border px-5 py-3 last:border-b-0`}>
                <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-[5px] text-xs font-semibold ${tm.cls}`}>
                  <tm.icon className="size-[13px]" aria-hidden />
                  {tm.label}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={`truncate text-sm font-semibold text-ink ${r.itemAMono ? 'font-mono' : ''}`}>
                    {r.itemA}
                  </span>
                  <span className="truncate font-mono text-[11px] text-ink-subtle">{r.itemB}</span>
                </div>
                <span className="truncate text-[13px] text-ink-muted">{r.pendiente}</span>
                <span className={`inline-flex items-center gap-1.5 font-mono text-[13px] font-semibold ${SLA_TEXT[w.tone]}`}>
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
            {`Mostrando ${filtered.length} en la cola`}
          </span>
          <div className="flex items-center gap-3">
            <button type="button" disabled className="grid size-[34px] place-items-center rounded-sm border border-border bg-surface text-ink-muted opacity-40">
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="text-[13px] text-ink-muted">Página 1</span>
            <button type="button" disabled className="grid size-[34px] place-items-center rounded-sm border border-border bg-surface text-ink-muted opacity-40">
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
