'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeftRight,
  Car,
  Check,
  ClipboardCheck,
  CreditCard,
  FileText,
  IdCard,
  Info,
  Lock,
  ScanFace,
  ShieldCheck,
  Trash2,
  Unlock,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { AdminDriverDocument, DriverDetail } from '@veo/api-client';
import {
  useDriverDetail,
  useDriverDecision,
  useDeleteDriver,
  useDniFaceMatch,
  useLicenseFaceMatch,
  useDocumentReview,
  useUnlockBiometric,
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
import { CreateInspectionDialog } from '@/components/fleet/fleet-forms';

/* ── Enums locales tipados (sin magic strings) ── */
const FaceMatchStatus = { NOT_RUN: 'NOT_RUN', MATCHED: 'MATCHED', NO_MATCH: 'NO_MATCH' } as const;
const Liveness = { NOT_RUN: 'NOT_RUN', PASSED: 'PASSED', DEGRADED: 'DEGRADED' } as const;
const DocStatus = {
  VALID: 'VALID',
  PENDING_REVIEW: 'PENDING_REVIEW',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
} as const;

/** Ícono + label por tipo de documento (frame AdminConductorDetalle · card Documentos). */
const DOC_META: Record<string, { icon: LucideIcon; label: string }> = {
  DNI: { icon: CreditCard, label: 'DNI (frente y reverso)' },
  LICENSE_A1: { icon: IdCard, label: 'Licencia de conducir A-I' },
  SOAT: { icon: ShieldCheck, label: 'SOAT vigente' },
  PROPERTY_CARD: { icon: FileText, label: 'Tarjeta de propiedad' },
  VEHICLE_PHOTO: { icon: Car, label: 'Foto del vehículo' },
  ITV: { icon: ClipboardCheck, label: 'Inspección técnica (ITV)' },
};

/** Pill de estado documental (mismos labels/tonos del frame). */
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

/** Estado de cabecera del conductor (pill junto al nombre). */
function headerStatus(d: DriverDetail): { tone: PillTone; label: string } {
  if (d.backgroundCheckStatus === 'CLEARED') return { tone: 'success', label: 'Aprobado' };
  if (d.backgroundCheckStatus === 'REJECTED') return { tone: 'danger', label: 'Rechazado' };
  return { tone: 'warn', label: 'En revisión' };
}

const CARD = 'overflow-hidden rounded-lg border border-border bg-surface';
const CARD_HEADER =
  'flex items-center justify-between gap-3 border-b border-border px-[18px] py-[14px]';

export default function DriverDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const query = useDriverDetail(id);
  const driver = query.data;

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">
          Necesitás el rol correspondiente para revisar a este conductor.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5 px-8 py-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/ops/drivers" className="text-ink-subtle hover:text-ink">
          Conductores
        </Link>
        <span className="text-ink-subtle">/</span>
        <span className="font-semibold text-ink">{driver?.fullName ?? id.slice(0, 8)}</span>
      </div>

      {query.isLoading ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="mt-10" />
      ) : driver ? (
        <>
          <Header driver={driver} onItvRegistered={() => void query.refetch()} />
          <div className="grid min-h-0 gap-5 lg:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-[18px]">
              <DocsCard driver={driver} onReviewed={() => void query.refetch()} />
              <BioCard driver={driver} />
            </div>
            <div className="flex flex-col gap-4">
              <DatosCard driver={driver} />
              <VehiculoCard driver={driver} />
              <Callout />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ────────────────────────────── HEADER ────────────────────────────── */

function Header({
  driver,
  onItvRegistered,
}: {
  driver: DriverDetail;
  onItvRegistered: () => void;
}) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useDriverDecision();
  const bio = driver.biometric;
  const readiness = driver.approvalReadiness;
  const itv = readiness.inspection;
  const livenessPassed = bio.livenessStatus === Liveness.PASSED;
  const facesRun = bio.dniFaceMatchedAt != null && bio.licenseFaceMatchedAt != null;
  const canApprove = facesRun && livenessPassed && readiness.documentsValid && itv.current;
  const blockReason = !livenessPassed
    ? 'El anti-spoofing del enrol no corrió; el conductor debe re-enrolar su biometría.'
    : !facesRun
      ? 'Corré ambos face-match para habilitar.'
      : !readiness.documentsValid
        ? `Faltan documentos válidos: ${readiness.missingDocuments.join(', ')}.`
        : !itv.current
          ? (ITV_HINT[itv.invalidReason ?? ''] ?? 'Falta la inspección técnica (ITV) del vehículo.')
          : '';
  const st = headerStatus(driver);
  const canApproveRole = can(user, 'drivers:approve');

  const chips = [
    `drv_${driver.id.slice(0, 8)}`,
    driver.dni ? `DNI ${driver.dni}` : null,
    driver.phone,
    `Alta ${date(driver.createdAt)}`,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      {/* Identity */}
      <div className="flex items-center gap-3.5">
        <Avatar name={driver.fullName} />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-ink">
              {driver.fullName ?? `Conductor ${driver.id.slice(0, 8)}`}
            </h1>
            <DotPill tone={st.tone}>{st.label}</DotPill>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-ink-subtle">
            {chips.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      {canApproveRole ? (
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2.5">
            {!itv.current && (itv.vehicleId || driver.vehicle) ? (
              <CreateInspectionDialog
                vehicleId={itv.vehicleId ?? driver.vehicle?.id}
                vehicleLabel={driver.vehicle?.plate ?? undefined}
                onCreated={onItvRegistered}
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface px-[18px] py-[11px] text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
                  >
                    <Car className="size-4" aria-hidden />
                    Registrar ITV
                  </button>
                }
              />
            ) : null}

            <StepUpDialog
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full border border-danger bg-danger/15 px-[18px] py-[11px] text-sm font-semibold text-danger transition-colors hover:bg-danger/20"
                >
                  <X className="size-4" aria-hidden />
                  Rechazar
                </button>
              }
              title="Rechazar alta"
              icon={AlertTriangle}
              description="El conductor recibirá el motivo, podrá corregir y reenviar a revisión. Requiere tu MFA (BR-S07)."
              confirmLabel="Rechazar alta"
              confirmVariant="danger"
              withReason
              reasonLabel="Motivo del rechazo (visible para el conductor)"
              reasonPlaceholder="Ej. La foto de la licencia no es legible. Vuelve a capturarla con buena luz."
              onVerified={async (reason) => {
                await decision.mutateAsync({ id: driver.id, decision: 'reject', reason });
                toast({ tone: 'success', title: 'Conductor rechazado' });
              }}
            />

            <StepUpDialog
              trigger={
                <button
                  type="button"
                  disabled={!canApprove}
                  className="inline-flex items-center gap-2 rounded-full bg-accent px-[18px] py-[11px] text-sm font-semibold text-accent-on shadow-[0_8px_24px_-6px_rgba(45,127,249,0.45)] transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                >
                  <Check className="size-4" aria-hidden />
                  Aprobar conductor
                </button>
              }
              title="Confirmá tu identidad"
              icon={ShieldCheck}
              description="Aprobar conductor · acción sensible. Ingresá el código de tu app (TOTP); la aprobación exige verificación fresca (BR-S07). El servidor revalida documentos + ITV."
              confirmLabel="Confirmar aprobación"
              onVerified={async () => {
                await decision.mutateAsync({ id: driver.id, decision: 'approve' });
                toast({ tone: 'success', title: 'Conductor aprobado' });
              }}
            />

            <DeleteDriverAction driverId={driver.id} driverName={driver.fullName} />
          </div>
          {!canApprove ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warn/15 px-3 py-1.5 text-[11px] font-semibold text-warn">
              <Lock className="size-3" aria-hidden />
              {blockReason}
            </span>
          ) : null}
        </div>
      ) : (
        <DotPill tone={st.tone}>{st.label}</DotPill>
      )}
    </div>
  );
}

/* ────────────────────────────── DOCUMENTOS ────────────────────────────── */

function StepBadge({ n }: { n: number }) {
  return (
    <span className="grid size-[22px] place-items-center rounded-full bg-accent/15 font-mono text-xs font-bold text-accent">
      {n}
    </span>
  );
}

function DocsCard({ driver, onReviewed }: { driver: DriverDetail; onReviewed: () => void }) {
  const valid = driver.documents.filter((d) => d.status === DocStatus.VALID).length;
  const pending = driver.documents.filter((d) => d.status === DocStatus.PENDING_REVIEW).length;
  return (
    <div className={CARD}>
      <div className={CARD_HEADER}>
        <div className="flex items-center gap-2.5">
          <StepBadge n={1} />
          <span className="text-[15px] font-bold text-ink">Documentos</span>
          <DotPill tone={pending > 0 ? 'warn' : 'success'}>
            {`${valid} válidos${pending > 0 ? ` · ${pending} por revisar` : ''}`}
          </DotPill>
        </div>
        <span className="hidden text-xs text-ink-subtle sm:block">
          Requisito para iniciar la verificación
        </span>
      </div>
      <div className="flex flex-col gap-2.5 p-3.5">
        {driver.documents.length === 0 ? (
          <EmptyState
            className="py-6"
            title="Sin documentos"
            description="El conductor no subió documentos."
          />
        ) : (
          driver.documents.map((doc) => (
            <DocRow key={doc.id} doc={doc} driverId={driver.id} onReviewed={onReviewed} />
          ))
        )}
      </div>
    </div>
  );
}

function DocRow({
  doc,
  driverId,
  onReviewed,
}: {
  doc: AdminDriverDocument;
  driverId: string;
  onReviewed: () => void;
}) {
  const { toast } = useToast();
  const review = useDocumentReview();
  const meta = DOC_META[doc.type] ?? { icon: FileText, label: doc.type };
  const Icon = meta.icon;
  const pill = docPill(doc.status);
  const firstImage = doc.images.find((i) => i.url)?.url ?? doc.url;
  const isPending = doc.status === DocStatus.PENDING_REVIEW;

  const act = async (d: 'approve' | 'reject', reason?: string) => {
    try {
      await review.mutateAsync({ id: doc.id, decision: d, driverId, reason });
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
          {doc.expiresAt ? `Vence ${date(doc.expiresAt)}` : `${doc.images.length} archivo(s)`}
        </span>
      </div>
      <DotPill tone={pill.tone}>{pill.label}</DotPill>
      <div className="flex items-center gap-1.5">
        {firstImage ? (
          <a
            href={firstImage}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
          >
            Ver
          </a>
        ) : null}
        {isPending ? (
          <>
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
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ────────────────────────────── BIOMÉTRICO ────────────────────────────── */

function BioCard({ driver }: { driver: DriverDetail }) {
  const dniMatch = useDniFaceMatch();
  const licenseMatch = useLicenseFaceMatch();
  const bio = driver.biometric;
  const livePassed = bio.livenessStatus === Liveness.PASSED;
  return (
    <div className={CARD}>
      <div className={CARD_HEADER}>
        <div className="flex items-center gap-2.5">
          <StepBadge n={2} />
          <span className="text-[15px] font-bold text-ink">Verificación biométrica</span>
        </div>
        <DotPill
          tone={
            livePassed ? 'success' : bio.livenessStatus === Liveness.DEGRADED ? 'warn' : 'neutral'
          }
        >
          {livePassed
            ? 'Prueba de vida ✓'
            : bio.livenessStatus === Liveness.DEGRADED
              ? 'Sin anti-spoofing'
              : 'Sin enrolar'}
        </DotPill>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        <MatchCard
          driver={driver}
          title="Rostro ↔ DNI"
          status={bio.dniFaceMatchStatus}
          score={bio.dniFaceMatchScore}
          mutation={dniMatch}
          docIcon={CreditCard}
        />
        <MatchCard
          driver={driver}
          title="Rostro ↔ Licencia"
          status={bio.licenseFaceMatchStatus}
          score={bio.licenseFaceMatchScore}
          mutation={licenseMatch}
          docIcon={IdCard}
        />
        <BiometricUnlockAction driverId={driver.id} />
      </div>
    </div>
  );
}

function MatchCard({
  driver,
  title,
  status,
  score,
  mutation,
  docIcon: DocIcon,
}: {
  driver: DriverDetail;
  title: string;
  status: string;
  score: number | null;
  mutation: ReturnType<typeof useDniFaceMatch>;
  docIcon: LucideIcon;
}) {
  const { toast } = useToast();
  const matched = status === FaceMatchStatus.MATCHED;
  const noMatch = status === FaceMatchStatus.NO_MATCH;
  const run = async () => {
    try {
      const res = await mutation.mutateAsync({ id: driver.id });
      toast({
        tone: res.matched ? 'success' : 'danger',
        title: res.matched ? `${title}: coincide` : `${title}: NO coincide`,
        description: res.reason ?? undefined,
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo verificar el rostro',
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
  };
  // El score guardado es coseno×100; mostrar "%" engaña (ver histórico) → banda cualitativa honesta, no %.
  const band =
    score != null ? (score / 100 >= 0.5 ? 'alta' : score / 100 >= 0.3 ? 'media' : 'baja') : null;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-bg p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        {matched ? (
          <DotPill tone="success">{band ? `Coincide · similitud ${band}` : 'Coincide'}</DotPill>
        ) : noMatch ? (
          <DotPill tone="danger">
            {band ? `No coincide · similitud ${band}` : 'No coincide'}
          </DotPill>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <ScanFace className="size-3.5" aria-hidden />
            Verificar
          </button>
        )}
      </div>
      <div className="flex items-center justify-center gap-2.5">
        <Thumb icon={ScanFace} label="Selfie" />
        <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-success/15 text-success">
          <ArrowLeftRight className="size-3.5" aria-hidden />
        </span>
        <Thumb icon={DocIcon} label="Documento" />
      </div>
    </div>
  );
}

function Thumb({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex h-24 flex-1 flex-col items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-2 text-ink-subtle">
      <Icon className="size-6" aria-hidden />
      <span className="text-[11px]">{label}</span>
    </div>
  );
}

function BiometricUnlockAction({ driverId }: { driverId: string }) {
  const { toast } = useToast();
  const unlock = useUnlockBiometric();
  const run = async () => {
    try {
      await unlock.mutateAsync({ id: driverId });
      toast({ tone: 'success', title: 'Verificación biométrica destrabada' });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo destrabar',
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={unlock.isPending}
      className="inline-flex items-center gap-2 self-start text-xs font-medium text-ink-subtle transition-colors hover:text-ink disabled:opacity-50"
    >
      <Unlock className="size-3.5" aria-hidden />
      Destrabar por intentos fallidos
    </button>
  );
}

/* ────────────────────────────── SIDEBAR ────────────────────────────── */

function InfoCard({
  icon: Icon,
  title,
  rows,
}: {
  icon: LucideIcon;
  title: string;
  rows: [string, string][];
}) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-[13px] font-bold text-ink">{title}</span>
      </div>
      <dl className="flex flex-col gap-2.5 p-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-[13px] text-ink-subtle">{k}</dt>
            <dd className="truncate font-mono text-[13px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DatosCard({ driver }: { driver: DriverDetail }) {
  return (
    <InfoCard
      icon={User}
      title="Datos personales"
      rows={[
        ['DNI', driver.dni ?? '—'],
        ['Nombre', driver.fullName ?? '—'],
        ['Nacimiento', driver.birthDate ? date(driver.birthDate) : '—'],
        ['Teléfono', driver.phone ?? '—'],
        ['Licencia', driver.licenseNumber ?? '—'],
      ]}
    />
  );
}

function VehiculoCard({ driver }: { driver: DriverDetail }) {
  if (!driver.vehicle) {
    return (
      <div className={CARD}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Car className="size-4 text-ink-subtle" aria-hidden />
          <span className="text-[13px] font-bold text-ink">Vehículo</span>
        </div>
        <p className="p-4 text-[13px] text-ink-subtle">El conductor aún no registró un vehículo.</p>
      </div>
    );
  }
  const v = driver.vehicle;
  return (
    <InfoCard
      icon={Car}
      title="Vehículo"
      rows={[
        ['Placa', v.plate],
        ['Marca', v.make || '—'],
        ['Modelo', v.model || '—'],
        ['Año', String(v.year)],
        ['Color', v.color || '—'],
      ]}
    />
  );
}

function Callout() {
  return (
    <div className="flex gap-3 rounded-sm border-l-[3px] border-accent bg-accent/10 p-4">
      <Info className="size-[18px] shrink-0 text-accent" aria-hidden />
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Aprobar o rechazar exige tu MFA. La decisión la aplica el backend; la UI solo la refleja.
      </p>
    </div>
  );
}

/* ────────────────────────────── DELETE ────────────────────────────── */

function friendlyDeleteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return (
        error.message ||
        'Este conductor tiene historial operativo y no puede borrarse. Usá el flujo de derecho al olvido (BR-S06).'
      );
    if (error.status === 403)
      return 'No tenés permiso para borrar conductores, o tu MFA no está fresca. Reautenticate e intentá de nuevo.';
    return error.message || 'No se pudo eliminar al conductor.';
  }
  return 'No se pudo eliminar al conductor.';
}

function DeleteDriverAction({
  driverId,
  driverName,
}: {
  driverId: string;
  driverName: string | null;
}) {
  const user = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const remove = useDeleteDriver();
  if (!can(user, 'drivers:delete')) return null;
  const who = driverName?.trim() ? driverName.trim() : 'este conductor';
  return (
    <StepUpDialog
      trigger={
        <button
          type="button"
          aria-label="Eliminar conductor"
          className="grid size-10 place-items-center rounded-full text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      }
      title="Eliminar conductor"
      icon={Trash2}
      description={`Vas a borrar a ${who}: su usuario, documentos y archivos en cascada. Es IRREVERSIBLE. Ingresá tu código TOTP para confirmar.`}
      confirmLabel="Eliminar"
      confirmVariant="danger"
      onVerified={async () => {
        try {
          await remove.mutateAsync({ id: driverId });
          toast({ tone: 'success', title: 'Conductor eliminado' });
          router.push('/ops/drivers');
        } catch (error) {
          toast({
            tone: 'danger',
            title: 'No se pudo eliminar',
            description: friendlyDeleteError(error),
          });
        }
      }}
    />
  );
}

/* ── ITV hint (motivo de invalidez) ── */
const ITV_HINT: Record<string, string> = {
  NONE: 'El vehículo no tiene ITV registrada.',
  NOT_PASSED: 'La ITV del vehículo está reprobada.',
  OVERDUE: 'La ITV del vehículo está vencida.',
  NO_VEHICLE: 'El conductor no tiene un vehículo operable.',
};
