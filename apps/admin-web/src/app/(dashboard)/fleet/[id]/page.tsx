'use client';

import { use } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Bike,
  Building2,
  CalendarCheck,
  CalendarClock,
  Car,
  Check,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  FileText,
  Info,
  Lock,
  ShieldCheck,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { FleetDocumentView, InspectionView, VehicleView } from '@veo/api-client';
import {
  useVehicle,
  useVehicleDocuments,
  useVehicleInspections,
  useDocumentReview,
} from '@/lib/api/queries';
import { date } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { Avatar } from '@/components/ui/avatar';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useToast } from '@/components/ui/toast';

const DocStatus = {
  VALID: 'VALID',
  PENDING_REVIEW: 'PENDING_REVIEW',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
} as const;

const DOC_META: Record<string, { icon: LucideIcon; label: string }> = {
  SOAT: { icon: ShieldCheck, label: 'SOAT vigente' },
  PROPERTY_CARD: { icon: FileText, label: 'Tarjeta de propiedad' },
  VEHICLE_PHOTO: { icon: Car, label: 'Foto del vehículo' },
  ITV: { icon: ClipboardCheck, label: 'Inspección técnica (ITV)' },
};

function docPill(status: string): { tone: PillTone; label: string } {
  switch (status) {
    case DocStatus.VALID:
      return { tone: 'success', label: 'Válido' };
    case DocStatus.PENDING_REVIEW:
      return { tone: 'warn', label: 'Por revisar' };
    case DocStatus.EXPIRING_SOON:
      return { tone: 'warn', label: 'Por vencer' };
    case DocStatus.EXPIRED:
      return { tone: 'danger', label: 'Vencido' };
    case DocStatus.REJECTED:
      return { tone: 'danger', label: 'Rechazado' };
    default:
      return { tone: 'neutral', label: status };
  }
}

function resultPill(result: string | null): { tone: PillTone; label: string } {
  if (result === 'PASSED') return { tone: 'success', label: 'Aprobada' };
  if (result === 'FAILED') return { tone: 'danger', label: 'Reprobada' };
  return { tone: 'warn', label: 'Observada' };
}

// Mismo criterio que la lista de Vehículos: Suspendido solo por vigencia REAL (doc/ITV vencida); `!operable`
// (sin ficha/docs) es "En revisión", no suspensión — un vehículo nuevo sin docs está en revisión de aptitud.
function headerStatus(v: VehicleView): { tone: PillTone; label: string } {
  if (v.status === DocStatus.EXPIRED || (v.itvHasInspection && !v.itvCurrent))
    return { tone: 'danger', label: 'Suspendido' };
  if (!v.operable || !v.itvHasInspection || v.status === DocStatus.EXPIRING_SOON)
    return { tone: 'warn', label: 'En revisión' };
  return { tone: 'success', label: 'Activo' };
}

const CARD = 'overflow-hidden rounded-lg border border-border bg-surface';

/** Muestra el valor o "—" si es vacío/null (fallback de display; empty-string → "—"). */
const dash = (x: string | null | undefined): string => (x && x.length > 0 ? x : '—');

export default function VehicleDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const query = useVehicle(id);
  const v = query.data;

  if (!can(user, 'fleet:view')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">
          Necesitás el rol correspondiente para ver este vehículo.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5 px-8 py-6">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/fleet" className="text-ink-subtle hover:text-ink">
          Flota
        </Link>
        <span className="text-ink-subtle">/</span>
        <Link href="/fleet" className="text-ink-subtle hover:text-ink">
          Vehículos
        </Link>
        <span className="text-ink-subtle">/</span>
        <span className="font-mono font-semibold text-ink">{v?.plate ?? id.slice(0, 8)}</span>
      </div>

      {query.isLoading ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="mt-10" />
      ) : v ? (
        <>
          <Header v={v} />
          <div className="grid min-h-0 gap-5 lg:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-[18px]">
              <DocsCard vehicleId={id} onReviewed={() => void query.refetch()} />
              <ItvCard v={v} vehicleId={id} />
            </div>
            <div className="flex flex-col gap-4">
              <FichaCard v={v} />
              <OwnerCard v={v} />
              <Callout />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Header({ v }: { v: VehicleView }) {
  const isMoto = v.vehicleType === 'MOTO';
  const TypeIcon = isMoto ? Bike : Car;
  const st = headerStatus(v);
  const chips = [
    [v.brand, v.model].filter(Boolean).join(' ') + (v.year ? ` · ${v.year}` : ''),
    v.color,
    `veh_${v.id.slice(0, 8)}`,
  ].filter(Boolean) as string[];
  return (
    <div className="flex items-center gap-3.5">
      <span className="grid size-[52px] shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-ink-muted">
        <TypeIcon className="size-6" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <h1 className="font-mono text-[22px] font-bold text-ink">{v.plate}</h1>
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-muted">
            <TypeIcon className="size-3" aria-hidden />
            {isMoto ? 'Moto' : 'Auto'}
          </span>
          <DotPill tone={st.tone}>{st.label}</DotPill>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
          {chips.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Documentos del vehículo ── */

function StepBadge({ n }: { n: number }) {
  return (
    <span className="grid size-[22px] place-items-center rounded-full bg-accent/15 font-mono text-xs font-bold text-accent">
      {n}
    </span>
  );
}

function DocsCard({ vehicleId, onReviewed }: { vehicleId: string; onReviewed: () => void }) {
  const docs = useVehicleDocuments(vehicleId);
  const items = docs.data?.items ?? [];
  const valid = items.filter((d) => d.status === DocStatus.VALID).length;
  const pending = items.filter((d) => d.status === DocStatus.PENDING_REVIEW).length;
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-[14px]">
        <div className="flex items-center gap-2.5">
          <StepBadge n={1} />
          <span className="text-[15px] font-bold text-ink">Documentos del vehículo</span>
          {items.length > 0 ? (
            <DotPill tone={pending > 0 ? 'warn' : 'success'}>
              {`${valid} válidos${pending > 0 ? ` · ${pending} por revisar` : ''}`}
            </DotPill>
          ) : null}
        </div>
        <span className="hidden text-xs text-ink-subtle sm:block">
          Requisito para verificar el vehículo
        </span>
      </div>
      <div className="flex flex-col gap-2.5 p-3.5">
        {docs.isLoading ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <EmptyState
            className="py-6"
            title="Sin documentos"
            description="El vehículo no tiene documentos cargados."
          />
        ) : (
          items.map((doc) => <DocRow key={doc.id} doc={doc} onReviewed={onReviewed} />)
        )}
      </div>
    </div>
  );
}

function DocRow({ doc, onReviewed }: { doc: FleetDocumentView; onReviewed: () => void }) {
  const { toast } = useToast();
  const review = useDocumentReview();
  const meta = DOC_META[doc.type] ?? { icon: FileText, label: doc.type };
  const Icon = meta.icon;
  const pill = docPill(doc.status);
  const isPending = doc.status === DocStatus.PENDING_REVIEW;
  const act = async (d: 'approve' | 'reject', reason?: string) => {
    try {
      await review.mutateAsync({ id: doc.id, decision: d, reason });
      toast({
        tone: 'success',
        title: d === 'approve' ? 'Documento aprobado' : 'Documento rechazado',
      });
      onReviewed();
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo revisar el documento',
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
  };
  return (
    <div className="flex items-center gap-3.5 rounded-md border border-border bg-surface-2 p-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-sm border border-border bg-bg text-ink-muted">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-ink">{meta.label}</span>
        <span className="truncate font-mono text-[11px] text-ink-subtle">
          {doc.expiresAt ? `Vence ${date(doc.expiresAt)}` : '—'}
        </span>
      </div>
      <DotPill tone={pill.tone}>{pill.label}</DotPill>
      {isPending ? (
        <div className="flex items-center gap-1.5">
          <StepUpDialog
            trigger={
              <button
                type="button"
                aria-label="Rechazar documento"
                className="grid size-[30px] place-items-center rounded-full border border-danger bg-danger/15 text-danger transition-colors hover:bg-danger/20"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            }
            title="Rechazar documento"
            icon={AlertTriangle}
            description={`Rechazás ${meta.label}. El conductor verá el motivo para corregirlo. Requiere tu MFA.`}
            confirmLabel="Rechazar documento"
            confirmVariant="danger"
            withReason
            reasonLabel="Motivo (visible para el conductor)"
            onVerified={(reason) => act('reject', reason)}
          />
          <button
            type="button"
            onClick={() => void act('approve')}
            disabled={review.isPending}
            className="inline-flex items-center gap-1.5 rounded-full border border-success bg-success/15 px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:bg-success/20 disabled:opacity-50"
          >
            <Check className="size-3.5" aria-hidden />
            Aprobar
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── ITV ── */

function ItvCard({ v, vehicleId }: { v: VehicleView; vehicleId: string }) {
  const insp = useVehicleInspections(vehicleId);
  const items = insp.data?.items ?? [];
  const latest = items[0];
  const headTone: PillTone = v.itvCurrent ? 'success' : v.itvHasInspection ? 'danger' : 'neutral';
  const headLabel = v.itvCurrent ? 'Vigente' : v.itvHasInspection ? 'Vencida' : 'Sin ITV';
  const kpis: { icon: LucideIcon; label: string; value: string; tone?: PillTone }[] = [
    {
      icon: CalendarCheck,
      label: 'Última inspección',
      value: latest?.inspectedAt ? date(latest.inspectedAt) : '—',
    },
    {
      icon: CircleCheck,
      label: 'Resultado',
      value: latest ? resultPill(latest.result).label : '—',
      tone: latest ? resultPill(latest.result).tone : undefined,
    },
    {
      icon: CalendarClock,
      label: 'Próximo vencimiento',
      value: v.itvNextDueAt ? date(v.itvNextDueAt) : '—',
    },
    { icon: Building2, label: 'Centro (CITV)', value: latest?.center ?? '—' },
  ];
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-[14px]">
        <div className="flex items-center gap-2.5">
          <StepBadge n={2} />
          <span className="text-[15px] font-bold text-ink">Inspección técnica (ITV)</span>
        </div>
        <DotPill tone={headTone}>{headLabel}</DotPill>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {kpis.map((k) => (
            <div
              key={k.label}
              className="flex flex-col gap-1.5 rounded-md border border-border bg-bg p-3.5"
            >
              <div className="flex items-center gap-1.5">
                <k.icon className="size-3.5 text-ink-subtle" aria-hidden />
                <span className="text-[11px] font-medium text-ink-subtle">{k.label}</span>
              </div>
              <span
                className={`text-[15px] font-semibold ${
                  k.tone === 'success'
                    ? 'text-success'
                    : k.tone === 'danger'
                      ? 'text-danger'
                      : 'text-ink'
                }`}
              >
                {k.value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-semibold uppercase tracking-[0.3px] text-ink-subtle">
            Historial de inspecciones
          </span>
          {insp.isLoading ? (
            <Skeleton className="h-10" />
          ) : items.length === 0 ? (
            <p className="text-[13px] text-ink-subtle">Sin inspecciones registradas.</p>
          ) : (
            items.map((it) => <InspRow key={it.id} it={it} />)
          )}
        </div>
      </div>
    </div>
  );
}

function InspRow({ it }: { it: InspectionView }) {
  const rp = resultPill(it.result);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <ClipboardCheck className="size-[15px] text-ink-muted" aria-hidden />
        <span className="text-[13px] font-semibold text-ink">
          {it.inspectedAt ? date(it.inspectedAt) : '—'}
        </span>
      </div>
      <DotPill tone={rp.tone}>{rp.label}</DotPill>
    </div>
  );
}

/* ── Sidebar ── */

function FichaCard({ v }: { v: VehicleView }) {
  const rows: [string, string][] = [
    ['Placa', v.plate],
    ['Marca', dash(v.brand)],
    ['Modelo', dash(v.model)],
    ['Año', v.year ? String(v.year) : '—'],
    ['Color', dash(v.color)],
    ['Tipo', v.vehicleType === 'MOTO' ? 'Moto' : 'Auto'],
    ['Categoría', dash(v.mtcCategory)],
  ];
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Car className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-[13px] font-bold text-ink">Ficha del vehículo</span>
      </div>
      <dl className="flex flex-col gap-2.5 p-4">
        {rows.map(([k, val]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-[13px] text-ink-subtle">{k}</dt>
            <dd className="truncate font-mono text-[13px] text-ink">{val}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function OwnerCard({ v }: { v: VehicleView }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <User className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-[13px] font-bold text-ink">Conductor dueño</span>
      </div>
      {v.driverId ? (
        <Link
          href={`/ops/drivers/${v.driverId}`}
          className="flex items-center gap-3 p-4 transition-colors hover:bg-surface-2/50"
        >
          <Avatar name={v.driverName} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold text-ink">
              {v.driverName ?? `drv_${v.driverId.slice(0, 8)}`}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
              <span
                className={`size-1.5 rounded-full ${v.operable ? 'bg-success' : 'bg-warn'}`}
                aria-hidden
              />
              {v.operable ? 'Conductor verificado' : 'Revisión pendiente'}
            </span>
          </div>
          <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden />
        </Link>
      ) : (
        <p className="p-4 text-[13px] text-ink-subtle">Sin conductor asignado.</p>
      )}
    </div>
  );
}

function Callout() {
  return (
    <div className="flex gap-3 rounded-sm border-l-[3px] border-accent bg-accent/10 p-4">
      <Info className="size-[18px] shrink-0 text-accent" aria-hidden />
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Un vehículo sin ITV vigente o con documento rechazado deja de ser operable. El estado lo
        deriva el backend de sus documentos e inspección; la UI solo lo refleja.
      </p>
    </div>
  );
}
