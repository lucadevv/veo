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
  Clock,
  CreditCard,
  FileText,
  Fingerprint,
  IdCard,
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
import { cn } from '@/lib/cn';
import { AdminTopbar as AdminTopbarLocal } from '@/components/layout/admin-topbar';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useToast } from '@/components/ui/toast';
import { useRequestAccess } from '@/lib/use-request-access';
import { CreateInspectionDialog } from '@/components/fleet/fleet-forms';
import { ActiveDriverActions } from '@/components/drivers/active-driver-actions';

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

/** Ícono + label por tipo de documento (card Documentos). */
const DOC_META: Record<string, { icon: LucideIcon; label: string }> = {
  DNI: { icon: CreditCard, label: 'DNI (frente y reverso)' },
  LICENSE_A1: { icon: IdCard, label: 'Licencia de conducir A-I' },
  SOAT: { icon: ShieldCheck, label: 'SOAT vigente' },
  PROPERTY_CARD: { icon: FileText, label: 'Tarjeta de propiedad' },
  BACKGROUND_CHECK: { icon: FileText, label: 'Certificado de antecedentes' },
  VEHICLE_PHOTO: { icon: Car, label: 'Foto del vehículo' },
  ITV: { icon: ClipboardCheck, label: 'Inspección técnica (ITV)' },
};

/** Pill de estado documental (mismos labels/tonos del frame). */
function docPill(status: string): { tone: PillTone; label: string } {
  switch (status) {
    case DocStatus.VALID:
      return { tone: 'success', label: 'Verificado' };
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

/** Banda cualitativa de similitud (el score guardado es coseno×100 — mostrarlo como "%" ENGAÑA, ver histórico). */
function scoreBand(score: number | null): 'alta' | 'media' | 'baja' | null {
  if (score == null) return null;
  const s = score / 100;
  return s >= 0.5 ? 'alta' : s >= 0.3 ? 'media' : 'baja';
}

const CARD = 'rounded-[20px] border border-black/[0.05] bg-surface shadow-3';
const CARD_TITLE = 'font-display text-base font-bold text-ink';

export default function DriverDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const requestAccess = useRequestAccess();
  const query = useDriverDetail(id);
  const driver = query.data;
  const st = driver ? headerStatus(driver) : null;

  const chips = driver
    ? ([
        `drv_${driver.id.slice(0, 8)}`,
        driver.dni ? `DNI ${driver.dni}` : null,
        driver.phone,
        `Alta ${date(driver.createdAt)}`,
      ].filter(Boolean) as string[])
    : [];

  const topbar = (
    <AdminTopbarLocal
      breadcrumb={
        <span className="flex items-center gap-2">
          <Link href="/ops/drivers" className="text-ink-muted transition-colors hover:text-ink">
            Conductores
          </Link>
          <span className="text-ink-subtle">/</span>
          <span className="text-ink-subtle">Verificación</span>
        </span>
      }
      title={driver?.fullName ?? `Conductor ${id.slice(0, 8)}`}
      subtitle={chips.length > 0 ? chips.join('  ·  ') : 'Verificación KYC · aprobación de alta'}
      actions={st ? <DotPill tone={st.tone}>{st.label}</DotPill> : undefined}
    />
  );

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Conductores"
          permission="drivers:view"
          onRequest={() => requestAccess('drivers:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col overflow-y-auto p-7">
        {query.isLoading ? (
          <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
            <Skeleton className="h-[420px] rounded-[20px]" />
            <Skeleton className="h-[420px] rounded-[20px]" />
          </div>
        ) : query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} className="mt-10" />
        ) : driver ? (
          <div className="grid min-h-0 gap-5 lg:grid-cols-[1fr_360px]">
            {/* Columna principal */}
            <div className="flex flex-col gap-[18px]">
              <BioCard driver={driver} />
              <DocsCard driver={driver} onReviewed={() => void query.refetch()} />
            </div>
            {/* Rail de decisión */}
            <div className="stagger flex flex-col gap-4">
              <DecisionCard driver={driver} onItvRegistered={() => void query.refetch()} />
              <VehiculoCard driver={driver} />
              <ActividadCard driver={driver} />
              <DatosCard driver={driver} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ────────────────────────────── CARD A · BIOMÉTRICO ────────────────────────────── */

function BioCard({ driver }: { driver: DriverDetail }) {
  const dniMatch = useDniFaceMatch();
  const licenseMatch = useLicenseFaceMatch();
  const bio = driver.biometric;

  // Pill general de coincidencia: ambos MATCHED → Coincide · algún NO_MATCH → No coincide · resto → Sin verificar.
  const anyNoMatch =
    bio.dniFaceMatchStatus === FaceMatchStatus.NO_MATCH ||
    bio.licenseFaceMatchStatus === FaceMatchStatus.NO_MATCH;
  const bothMatched =
    bio.dniFaceMatchStatus === FaceMatchStatus.MATCHED &&
    bio.licenseFaceMatchStatus === FaceMatchStatus.MATCHED;
  const overall: { tone: PillTone; label: string } = anyNoMatch
    ? { tone: 'danger', label: 'No coincide' }
    : bothMatched
      ? { tone: 'success', label: 'Coincide' }
      : { tone: 'neutral', label: 'Sin verificar' };

  // Foto del DNI (primera imagen firmada del doc DNI) y selfie del enrol (best-effort, puede venir null).
  const dniDoc = driver.documents.find((d) => d.type === 'DNI');
  const dniUrl = dniDoc?.images.find((i) => i.url)?.url ?? dniDoc?.url ?? null;
  const selfieUrl = bio.faceSelfieUrl;

  const livePill: { tone: PillTone; label: string } =
    bio.livenessStatus === Liveness.PASSED
      ? { tone: 'success', label: 'Superada' }
      : bio.livenessStatus === Liveness.DEGRADED
        ? { tone: 'warn', label: 'Sin anti-spoofing' }
        : { tone: 'neutral', label: 'Sin correr' };

  return (
    <section className={CARD}>
      <div className="flex items-start justify-between gap-3 px-[22px] pb-3 pt-[22px]">
        <div className="flex flex-col gap-1">
          <h2 className={CARD_TITLE}>Verificación biométrica</h2>
          <p className="text-[13px] text-ink-muted">
            Face-match DNI ↔ selfie en vivo · biometric-service (ONNX, self-hosted)
          </p>
        </div>
        <DotPill tone={overall.tone}>{overall.label}</DotPill>
      </div>

      <div className="flex flex-col gap-5 px-[22px] pb-[22px] sm:flex-row sm:items-center">
        <RingGauge
          score={bio.dniFaceMatchScore}
          noMatch={bio.dniFaceMatchStatus === FaceMatchStatus.NO_MATCH}
        />
        <div className="grid flex-1 grid-cols-2 gap-3">
          <PhotoTile url={dniUrl} label="Foto DNI" icon={CreditCard} />
          <PhotoTile url={selfieUrl} label="Selfie en vivo" icon={ScanFace} />
        </div>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-[color:var(--divider)] px-[22px] py-[18px]">
        <MatchRow
          driver={driver}
          title="DNI ↔ Selfie"
          status={bio.dniFaceMatchStatus}
          score={bio.dniFaceMatchScore}
          mutation={dniMatch}
        />
        <MatchRow
          driver={driver}
          title="Licencia ↔ Selfie"
          status={bio.licenseFaceMatchStatus}
          score={bio.licenseFaceMatchScore}
          mutation={licenseMatch}
        />
        <ResultRow
          icon={Fingerprint}
          label="Prueba de vida (liveness)"
          right={<DotPill tone={livePill.tone}>{livePill.label}</DotPill>}
        />
        <BiometricUnlockAction driverId={driver.id} />
      </div>
    </section>
  );
}

/**
 * Gauge honesto de similitud. El anillo se llena proporcional al score (coseno×100), pero el CENTRO muestra la
 * BANDA cualitativa (Alta/Media/Baja), NO un "%": el score no es una probabilidad de coincidencia y mostrarlo
 * como porcentaje engaña (regla de honestidad preservada del render previo).
 */
function RingGauge({ score, noMatch }: { score: number | null; noMatch: boolean }) {
  const band = scoreBand(score);
  const pct = score != null ? Math.min(Math.max(score / 100, 0), 1) : 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  const color = noMatch
    ? 'var(--danger)'
    : band === 'alta'
      ? 'var(--success)'
      : band === 'media'
        ? 'var(--warn)'
        : band === 'baja'
          ? 'var(--danger)'
          : 'var(--border-strong)';
  const BAND_LABEL: Record<'alta' | 'media' | 'baja', string> = {
    alta: 'Alta',
    media: 'Media',
    baja: 'Baja',
  };
  const center = band ? BAND_LABEL[band] : 'Sin correr';
  return (
    <div className="relative shrink-0 self-center" style={{ width: 132, height: 132 }}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--divider)" strokeWidth="12" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-display text-lg font-bold tracking-[-0.5px] text-ink">{center}</span>
        <span className="text-[10px] uppercase tracking-[0.06em] text-ink-subtle">similitud</span>
      </div>
    </div>
  );
}

function PhotoTile({ url, label, icon: Icon }: { url: string | null; label: string; icon: LucideIcon }) {
  return (
    <div className="flex flex-col gap-1.5">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block h-24 overflow-hidden rounded-xl border border-border bg-surface-2"
        >
          <img src={url} alt={label} className="size-full object-cover" />
        </a>
      ) : (
        <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-surface-2 text-ink-subtle">
          <Icon className="size-6" aria-hidden />
          <span className="text-[11px]">Sin archivo</span>
        </div>
      )}
      <span className="text-center text-[11px] font-medium text-ink-muted">{label}</span>
    </div>
  );
}

function ResultRow({
  icon: Icon,
  label,
  right,
}: {
  icon: LucideIcon;
  label: string;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-ink-muted">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="truncate text-[13px] font-semibold text-ink">{label}</span>
      </span>
      <span className="shrink-0">{right}</span>
    </div>
  );
}

function MatchRow({
  driver,
  title,
  status,
  score,
  mutation,
}: {
  driver: DriverDetail;
  title: string;
  status: string;
  score: number | null;
  mutation: ReturnType<typeof useDniFaceMatch>;
}) {
  const { toast } = useToast();
  const user = useSession();
  // Correr un face-match es un paso del flujo de aprobación de compliance: el server lo gatea con
  // `@Permission('drivers:approve')`. El front lo refleja: quien NO aprueba no ve "Verificar", solo el estado.
  const canRun = can(user, 'drivers:approve');
  const matched = status === FaceMatchStatus.MATCHED;
  const noMatch = status === FaceMatchStatus.NO_MATCH;
  const band = scoreBand(score);
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

  const right = matched ? (
    <DotPill tone="success">{band ? `Verificado · similitud ${band}` : 'Verificado'}</DotPill>
  ) : noMatch ? (
    <DotPill tone="danger">{band ? `No coincide · similitud ${band}` : 'No coincide'}</DotPill>
  ) : canRun ? (
    <button
      type="button"
      onClick={() => void run()}
      disabled={mutation.isPending}
      className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
    >
      <ScanFace className="size-3.5" aria-hidden />
      Verificar
    </button>
  ) : (
    <DotPill tone="neutral">Sin verificar</DotPill>
  );

  return <ResultRow icon={ArrowLeftRight} label={title} right={right} />;
}

function BiometricUnlockAction({ driverId }: { driverId: string }) {
  const { toast } = useToast();
  const user = useSession();
  const unlock = useUnlockBiometric();
  // Destrabar la biometría es `@Permission('drivers:approve')` server-side: paridad front (quien no aprueba no la ve).
  if (!can(user, 'drivers:approve')) return null;
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
      className="mt-0.5 inline-flex items-center gap-2 self-start text-xs font-medium text-ink-subtle transition-colors hover:text-ink disabled:opacity-50"
    >
      <Unlock className="size-3.5" aria-hidden />
      Destrabar por intentos fallidos
    </button>
  );
}

/* ────────────────────────────── CARD B · DOCUMENTOS ────────────────────────────── */

function DocsCard({ driver, onReviewed }: { driver: DriverDetail; onReviewed: () => void }) {
  const valid = driver.documents.filter((d) => d.status === DocStatus.VALID).length;
  const pending = driver.documents.filter((d) => d.status === DocStatus.PENDING_REVIEW).length;
  return (
    <section className={CARD}>
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--divider)] px-[22px] py-[18px]">
        <div className="flex items-center gap-2.5">
          <h2 className={CARD_TITLE}>Documentos</h2>
          <DotPill tone={pending > 0 ? 'warn' : 'success'}>
            {`${valid} verificados${pending > 0 ? ` · ${pending} por revisar` : ''}`}
          </DotPill>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 p-[18px]">
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
    </section>
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
    <div className="flex items-center gap-3.5 rounded-xl border border-border bg-surface-2 p-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-surface text-ink-muted">
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

/* ────────────────────────────── RAIL · DECISIÓN ────────────────────────────── */

/* ── ITV hint (motivo de invalidez) ── */
const ITV_HINT: Record<string, string> = {
  NONE: 'El vehículo no tiene ITV registrada.',
  NOT_PASSED: 'La ITV del vehículo está reprobada.',
  OVERDUE: 'La ITV del vehículo está vencida.',
  NO_VEHICLE: 'El conductor no tiene un vehículo operable.',
};

function DecisionCard({
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
  // "Aprobado" NO es un estado del conductor: es el veredicto de antecedentes (CLEARED) que setea approve().
  // Sobre un conductor YA aprobado, "Aprobar" es imposible (identity responde 409); la única acción es REVOCAR.
  const isApproved = driver.backgroundCheckStatus === 'CLEARED';
  const canApprove =
    !isApproved && facesRun && livenessPassed && readiness.documentsValid && itv.current;
  const blockReason = !livenessPassed
    ? 'El anti-spoofing del enrol no corrió; el conductor debe re-enrolar su biometría.'
    : !facesRun
      ? 'Corré ambos face-match para habilitar.'
      : !readiness.documentsValid
        ? `Faltan documentos válidos: ${readiness.missingDocuments.join(', ')}.`
        : !itv.current
          ? (ITV_HINT[itv.invalidReason ?? ''] ?? 'Falta la inspección técnica (ITV) del vehículo.')
          : '';
  const canApproveRole = can(user, 'drivers:approve');
  const canSuspend = can(user, 'drivers:suspend');

  // Si no puede aprobar NI suspender NI borrar, no hay decisión que tomar acá.
  if (!canApproveRole && !canSuspend && !can(user, 'drivers:delete')) return null;

  return (
    <section className={CARD}>
      <div className="border-b border-[color:var(--divider)] px-[22px] py-[18px]">
        <h2 className={CARD_TITLE}>Decisión de verificación</h2>
        <p className="mt-1 flex items-start gap-1.5 text-[13px] text-ink-muted">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-accent" aria-hidden />
          Requiere doble verificación (four-eyes) y tu MFA.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 p-[18px]">
        {canApproveRole ? (
          <>
            {!isApproved ? (
              <StepUpDialog
                trigger={
                  <button
                    type="button"
                    disabled={!canApprove}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-control bg-success px-4 py-3 text-sm font-semibold text-success-on shadow-brand transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                  >
                    <Check className="size-4" aria-hidden />
                    Aprobar conductor
                  </button>
                }
                title="Confirmá tu identidad"
                icon={ShieldCheck}
                description="Aprobar conductor · acción sensible. Ingresá el código de tu app (TOTP); la aprobación exige verificación fresca (BR-S07). El servidor revalida documentos + ITV."
                confirmLabel="Aprobar conductor"
                onVerified={async () => {
                  await decision.mutateAsync({ id: driver.id, decision: 'approve' });
                  toast({ tone: 'success', title: 'Conductor aprobado' });
                }}
              />
            ) : null}

            {!isApproved && !canApprove ? (
              <span className="inline-flex items-start gap-1.5 rounded-xl bg-warn/15 px-3 py-2 text-[12px] font-medium text-warn">
                <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
                {blockReason}
              </span>
            ) : null}

            <StepUpDialog
              trigger={
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-control border border-danger bg-danger/10 px-4 py-3 text-sm font-semibold text-danger transition-colors hover:bg-danger/15"
                >
                  <X className="size-4" aria-hidden />
                  {isApproved ? 'Revocar aprobación' : 'Rechazar'}
                </button>
              }
              title={isApproved ? 'Revocar aprobación' : 'Rechazar alta'}
              icon={AlertTriangle}
              description={
                isApproved
                  ? 'El conductor volverá a revisión y queda FUERA de operación de inmediato (CLEARED → REJECTED). Requiere tu MFA (BR-S07).'
                  : 'El conductor recibirá el motivo, podrá corregir y reenviar a revisión. Requiere tu MFA (BR-S07).'
              }
              confirmLabel={isApproved ? 'Revocar aprobación' : 'Rechazar alta'}
              confirmVariant="danger"
              withReason
              reasonLabel={
                isApproved
                  ? 'Motivo de la revocación (visible para el conductor)'
                  : 'Motivo del rechazo (visible para el conductor)'
              }
              reasonPlaceholder="Ej. La foto de la licencia no es legible. Vuelve a capturarla con buena luz."
              onVerified={async (reason) => {
                await decision.mutateAsync({ id: driver.id, decision: 'reject', reason });
                toast({
                  tone: 'success',
                  title: isApproved ? 'Aprobación revocada' : 'Conductor rechazado',
                });
              }}
            />

            {/* "Registrar ITV" crea una inspección (POST /fleet/inspections · @Permission('fleet:manage')). Un rol
                que APRUEBA conductores pero NO gestiona flota comería un 403 al enviarla → la afordancia solo se
                muestra si además puede crear la inspección (fleet:manage), no solo por el contexto de aprobación. */}
            {can(user, 'fleet:manage') && !itv.current && (itv.vehicleId || driver.vehicle) ? (
              <CreateInspectionDialog
                vehicleId={itv.vehicleId ?? driver.vehicle?.id}
                vehicleLabel={driver.vehicle?.plate ?? undefined}
                onCreated={onItvRegistered}
                trigger={
                  <button
                    type="button"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-control border border-border-strong bg-surface px-4 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
                  >
                    <Car className="size-4" aria-hidden />
                    Registrar ITV
                  </button>
                }
              />
            ) : null}
          </>
        ) : null}

        {/* Suspender / reactivar (safety, operativo) — dato REAL: currentStatus + suspensionCauses del detalle. */}
        {canSuspend ? (
          <div className="flex flex-col gap-2 border-t border-[color:var(--divider)] pt-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-ink-subtle">
              Estado operativo
            </span>
            <ActiveDriverActions
              driver={{
                id: driver.id,
                status: driver.currentStatus,
                suspensionCauses: driver.suspensionCauses,
              }}
            />
          </div>
        ) : null}

        <DeleteDriverAction driverId={driver.id} driverName={driver.fullName} />
      </div>
    </section>
  );
}

/* ────────────────────────────── RAIL · VEHÍCULO ────────────────────────────── */

function RailCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={CARD}>
      <div className="flex items-center gap-2 border-b border-[color:var(--divider)] px-[22px] py-3.5">
        <Icon className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-[13px] font-bold text-ink">{title}</span>
      </div>
      {children}
    </section>
  );
}

function DescList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-col gap-2.5 px-[22px] py-4">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-3">
          <dt className="text-[13px] text-ink-subtle">{k}</dt>
          <dd className="truncate font-mono text-[13px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DatosCard({ driver }: { driver: DriverDetail }) {
  return (
    <RailCard icon={User} title="Datos personales">
      <DescList
        rows={[
          ['DNI', driver.dni ?? '—'],
          ['Nombre', driver.fullName ?? '—'],
          ['Nacimiento', driver.birthDate ? date(driver.birthDate) : '—'],
          ['Teléfono', driver.phone ?? '—'],
          ['Licencia', driver.licenseNumber ?? '—'],
        ]}
      />
    </RailCard>
  );
}

function VehiculoCard({ driver }: { driver: DriverDetail }) {
  if (!driver.vehicle) {
    return (
      <RailCard icon={Car} title="Vehículo">
        <p className="px-[22px] py-4 text-[13px] text-ink-subtle">
          El conductor aún no registró un vehículo.
        </p>
      </RailCard>
    );
  }
  const v = driver.vehicle;
  return (
    <RailCard icon={Car} title="Vehículo">
      <DescList
        rows={[
          ['Modelo', [v.make, v.model].filter(Boolean).join(' ') || '—'],
          ['Placa', v.plate],
          ['Año', String(v.year)],
          ['Color', v.color || '—'],
          // Capacidad no está en el contrato del vehículo → "—" honesto.
          ['Capacidad', '—'],
        ]}
      />
    </RailCard>
  );
}

/* ────────────────────────────── RAIL · ACTIVIDAD ────────────────────────────── */

function ActividadCard({ driver }: { driver: DriverDetail }) {
  const bio = driver.biometric;
  // Timeline de timestamps REALES del detalle; se omiten los eventos sin dato (no se inventan fechas).
  const events = (
    [
      { label: 'Registro creado', at: driver.createdAt },
      { label: 'Biometría enrolada', at: bio.faceEnrolledAt },
      { label: 'Face-match DNI ejecutado', at: bio.dniFaceMatchedAt },
      { label: 'Face-match licencia ejecutado', at: bio.licenseFaceMatchedAt },
      { label: 'Última verificación', at: bio.lastVerifiedAt },
    ] as { label: string; at: string | null }[]
  ).filter((e): e is { label: string; at: string } => e.at != null);

  return (
    <RailCard icon={Clock} title="Actividad">
      <ol className="flex flex-col gap-0 px-[22px] py-4">
        {events.map((e, i) => (
          <li key={e.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-1 size-2 shrink-0 rounded-full bg-accent" aria-hidden />
              {i < events.length - 1 ? (
                <span className="w-px flex-1 bg-[color:var(--divider)]" aria-hidden />
              ) : null}
            </div>
            <div className={cn('flex flex-col gap-0.5', i < events.length - 1 ? 'pb-4' : '')}>
              <span className="text-[13px] font-semibold text-ink">{e.label}</span>
              <span className="font-mono text-[11px] text-ink-subtle">{date(e.at)}</span>
            </div>
          </li>
        ))}
      </ol>
    </RailCard>
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
          className="mt-0.5 inline-flex items-center gap-2 self-start text-xs font-medium text-ink-subtle transition-colors hover:text-danger"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Eliminar conductor
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
