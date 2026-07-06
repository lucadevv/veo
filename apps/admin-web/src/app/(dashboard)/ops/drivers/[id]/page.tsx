'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Car, Check, Circle, Lock, ScanFace, Trash2, Unlock, X } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { DriverDetail } from '@veo/api-client';
import {
  useDriverDetail,
  useDriverDecision,
  useDeleteDriver,
  useDniFaceMatch,
  useLicenseFaceMatch,
  useUnlockBiometric,
} from '@/lib/api/queries';
import { date, dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useToast } from '@/components/ui/toast';
import { DocumentViewer } from '@/components/drivers/document-viewer';
import { CreateInspectionDialog } from '@/components/fleet/fleet-forms';

/**
 * Detalle de revisión de un conductor (GET /ops/drivers/:id): datos core + biométrico + VISOR de
 * documentos para aprobar/rechazar el onboarding. Vive DENTRO del grupo (dashboard) → hereda el layout
 * autenticado por JWT (ruta protegida). Espeja trips/[id]: `use(params)` + hook con cliente autenticado.
 * El bff además gatea esta ruta a Compliance+ (la UI refleja el permiso `drivers:view`).
 */
export default function DriverDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const query = useDriverDetail(id);
  const driver = query.data;

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Conductor"
          breadcrumbs={[
            { label: 'Flota' },
            { label: 'Conductores', href: '/ops/drivers' },
            { label: id.slice(0, 8) },
          ]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para revisar a este conductor."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={driver?.fullName ?? `Conductor ${id.slice(0, 8)}`}
        breadcrumbs={[
          { label: 'Operación' },
          { label: 'Conductores', href: '/ops/drivers' },
          { label: id.slice(0, 8) },
        ]}
        actions={
          driver ? (
            <div className="flex items-center gap-3">
              <StatusPill status={driver.currentStatus} />
              <DeleteDriverAction driverId={driver.id} driverName={driver.fullName} />
            </div>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : driver ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 lg:p-6">
          {/* Barra de aprobación: la acción PRIMARIA de la pantalla, al frente y gateada (refleja TODOS los
              gates server-side: face-match + liveness + documentos + ITV). El operador ve el readiness de un
              vistazo y registra la ITV inline si es lo que falta. */}
          <ApprovalBar driver={driver} onItvRegistered={() => void query.refetch()} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Datos del conductor</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Nombre" value={driver.fullName ?? '—'} />
                <Detail label="Teléfono" value={driver.phone ?? '—'} mono />
                <Detail label="DNI" value={driver.dni ?? '—'} mono />
                <Detail label="Fecha de nacimiento" value={driver.birthDate ? date(driver.birthDate) : '—'} />
                <Detail label="Licencia" value={driver.licenseNumber ?? '—'} mono />
                <Detail label="Alta" value={dateTime(driver.createdAt)} />
                <div>
                  <dt className="text-xs text-ink-muted">Antecedentes</dt>
                  <dd className="mt-1">
                    <StatusPill status={driver.backgroundCheckStatus} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">KYC</dt>
                  <dd className="mt-1">
                    <StatusPill status={driver.kycStatus} />
                  </dd>
                </div>
                {driver.rejectionReason ? (
                  <div className="col-span-2">
                    <dt className="text-xs text-ink-muted">Motivo del rechazo</dt>
                    <dd className="text-danger">{driver.rejectionReason}</dd>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Verificación biométrica</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <EnrolSelfiePreview url={driver.biometric.faceSelfieUrl} />
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Detail
                    label="Rostro enrolado"
                    value={dateTime(driver.biometric.faceEnrolledAt)}
                  />
                  <Detail
                    label="Anti-spoofing (liveness)"
                    value={livenessLabel(
                      driver.biometric.livenessStatus,
                      driver.biometric.livenessScore,
                    )}
                  />
                  <Detail
                    label="Última verificación"
                    value={dateTime(driver.biometric.lastVerifiedAt)}
                  />
                </div>
                <FaceMatchBindings driver={driver} />
                <BiometricUnlockAction driverId={driver.id} />
              </CardContent>
            </Card>
          </div>

          {/* Ficha del vehículo (F2 · C1): el operador ve QUÉ auto opera antes de aprobar. */}
          <Card>
            <CardHeader>
              <CardTitle>Vehículo</CardTitle>
            </CardHeader>
            <CardContent>
              {driver.vehicle ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                  <Detail label="Placa" value={driver.vehicle.plate} mono />
                  <Detail label="Marca" value={driver.vehicle.make || '—'} />
                  <Detail label="Modelo" value={driver.vehicle.model || '—'} />
                  <Detail label="Año" value={String(driver.vehicle.year)} />
                  <Detail label="Color" value={driver.vehicle.color || '—'} />
                  <Detail label="Tipo" value={driver.vehicle.vehicleType} />
                  <div>
                    <dt className="text-xs text-ink-muted">Documentación</dt>
                    <dd className="mt-1">
                      <StatusPill status={driver.vehicle.docStatus} />
                    </dd>
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={<Car className="size-6" aria-hidden />}
                  title="Sin vehículo registrado"
                  description="El conductor todavía no registró un vehículo."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Documentos</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentViewer
                documents={driver.documents}
                isLoading={false}
                isError={false}
                onReload={() => void query.refetch()}
                isReloading={query.isFetching}
                driverId={driver.id}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-ink tabular' : 'text-ink'}>{value}</dd>
    </div>
  );
}

/**
 * El `dniFaceMatchScore` GUARDADO está en escala 0..100 (= similitud coseno ArcFace × 100). Mostrarlo como
 * "{score}%" ENGAÑA: un 0.40 de coseno legítimo (DNI viejo/baja-res, misma persona) se LEE como "40% de
 * confianza" → el operador cree que hay 60% de que NO sea la persona, cuando en realidad 0.40 es un coseno
 * sano para doc-vs-selfie (el umbral del doc-match es 0.30, más laxo que el de turno 0.40). Devolvemos el
 * coseno REAL (no un porcentaje de confianza inventado) + una banda cualitativa honesta.
 */
function formatFaceMatchScore(score0to100: number): { cosine: string; band: string } {
  const cosine = score0to100 / 100;
  // Bandas cualitativas sobre el coseno ArcFace (doc-vs-selfie). NO son probabilidades: orientan al
  // operador sin fingir precisión que no tenemos (sin calibración FMR a población real).
  const band =
    cosine >= 0.5 ? 'similitud alta' : cosine >= 0.3 ? 'similitud media' : 'similitud baja';
  return { cosine: cosine.toFixed(2), band };
}

/**
 * Estados tipados del binding documento↔selfie (= enum `DniFaceMatchStatus` del contrato). Const local para
 * conmutar el panel SIN strings mágicos (`status === FaceMatchStatus.MATCHED` en vez de `=== 'MATCHED'`).
 */
const FaceMatchStatus = {
  NOT_RUN: 'NOT_RUN',
  MATCHED: 'MATCHED',
  NO_MATCH: 'NO_MATCH',
} as const;

/**
 * Estados tipados del liveness PASIVO (= enum `passiveLivenessStatus` del contrato). Const local para conmutar
 * el chip + el gate SIN strings mágicos. PASSED = el PAD corrió y dio viva; DEGRADED = enroló sin anti-spoofing
 * (modelo ausente); NOT_RUN = aún no enroló. Un spoof NUNCA llega acá (se rechaza en el enrol).
 */
const PassiveLivenessStatus = {
  NOT_RUN: 'NOT_RUN',
  PASSED: 'PASSED',
  DEGRADED: 'DEGRADED',
} as const;

/**
 * Descriptor de un binding documento↔selfie para el panel CANÓNICO. Centraliza las labels/copys y el SELECTOR
 * tipado de los 3 campos del binding (sin indexar por string) → un panel, dos documentos (DNI y licencia ·
 * Lote C · binding MÁS FUERTE). Acá muere el copy-paste entre el panel del DNI y el del brevete.
 */
interface FaceMatchDoc {
  /** Etiqueta corta del binding ("Rostro vs DNI" / "Rostro vs licencia"). */
  label: string;
  /** Verbo del CTA cuando aún no se corrió. */
  verifyLabel: string;
  /** Hint cuando no se corrió. */
  emptyHint: string;
  /** Títulos del toast al coincidir / no coincidir. */
  matchTitle: string;
  noMatchTitle: string;
  /** Qué revisar si el match falla (toast de error). */
  errorHint: string;
  /** Extrae los 3 campos del binding del bloque biométrico (tipado, sin strings de keys). */
  select: (bio: DriverDetail['biometric']) => {
    status: DriverDetail['biometric']['dniFaceMatchStatus'];
    score: number | null;
    at: string | null;
  };
}

const FACE_MATCH_DNI: FaceMatchDoc = {
  label: 'Rostro vs DNI',
  verifyLabel: 'Verificar rostro vs DNI',
  emptyHint: 'Aún no se verificó el rostro del DNI contra la biometría enrolada.',
  matchTitle: 'Rostro coincide con el DNI',
  noMatchTitle: 'El rostro NO coincide con el DNI',
  errorHint: 'Revisá que el conductor tenga biometría enrolada y la foto FRONT del DNI cargada.',
  select: (b) => ({
    status: b.dniFaceMatchStatus,
    score: b.dniFaceMatchScore,
    at: b.dniFaceMatchedAt,
  }),
};

const FACE_MATCH_LICENSE: FaceMatchDoc = {
  label: 'Rostro vs licencia',
  verifyLabel: 'Verificar rostro vs licencia',
  emptyHint: 'Aún no se verificó el rostro del brevete contra la biometría enrolada.',
  matchTitle: 'Rostro coincide con la licencia',
  noMatchTitle: 'El rostro NO coincide con la licencia',
  errorHint: 'Revisá que el conductor tenga biometría enrolada y la foto del brevete cargada.',
  select: (b) => ({
    status: b.licenseFaceMatchStatus,
    score: b.licenseFaceMatchScore,
    at: b.licenseFaceMatchedAt,
  }),
};

/**
 * Panel CANÓNICO del binding documento↔selfie (DNI o licencia). Muestra el resultado GUARDADO (Coincide ✓ /
 * No coincide ✗ + similitud coseno honesta) y un CTA que dispara el match en el admin-bff. Parametrizado por
 * `doc` (descriptor) + la `mutation` del documento — un solo componente, cero copy-paste. El operador VE el
 * binding antes de aprobar; el gate REAL (ambos bindings ejecutados) es server-side, esto solo refleja.
 */
function FaceMatchPanel({
  driver,
  doc,
  mutation,
}: {
  driver: DriverDetail;
  doc: FaceMatchDoc;
  mutation: ReturnType<typeof useDniFaceMatch>;
}) {
  const { toast } = useToast();
  const { status, score, at } = doc.select(driver.biometric);

  const runMatch = async () => {
    try {
      const res = await mutation.mutateAsync({ id: driver.id });
      toast({
        tone: res.matched ? 'success' : 'danger',
        title: res.matched ? doc.matchTitle : doc.noMatchTitle,
        description: res.reason ?? undefined,
      });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'No se pudo verificar el rostro',
        description: error instanceof ApiError ? error.message : doc.errorHint,
      });
    }
  };

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <dt className="text-xs text-ink-muted">{doc.label}</dt>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void runMatch()}
          disabled={mutation.isPending}
        >
          <ScanFace className="size-4" aria-hidden />
          {status === FaceMatchStatus.NOT_RUN ? doc.verifyLabel : 'Volver a verificar'}
        </Button>
      </div>
      {status === FaceMatchStatus.NOT_RUN ? (
        <p className="text-xs text-ink-muted">{doc.emptyHint}</p>
      ) : status === FaceMatchStatus.MATCHED ? (
        <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-success">
          <Check className="size-4" aria-hidden />
          <span className="font-medium">Coincide</span>
          {score !== null ? (
            <span className="tabular text-xs text-success/80">
              {`similitud ${formatFaceMatchScore(score).cosine} · ${formatFaceMatchScore(score).band}`}
            </span>
          ) : null}
          <span className="ml-auto text-xs text-ink-muted">{dateTime(at)}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-danger">
          <X className="size-4" aria-hidden />
          <span className="font-medium">No coincide</span>
          {score !== null ? (
            <span className="tabular text-xs text-danger/80">
              {`similitud ${formatFaceMatchScore(score).cosine} · ${formatFaceMatchScore(score).band}`}
            </span>
          ) : null}
          <span className="ml-auto text-xs text-ink-muted">{dateTime(at)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Los DOS bindings documento↔selfie (DNI + licencia · Lote C · binding MÁS FUERTE) que el operador VE antes de
 * aprobar. Llama ambas mutations acá (reglas de hooks) y renderiza un panel canónico por documento.
 */
/**
 * F5 · selfie del enrol del conductor, como AYUDA VISUAL para el operador (casos dudosos: dirimir un NO_MATCH
 * del brevete low-res a ojo). NO es la verificación — esa la hace el match contra DNI/licencia. Thumbnail
 * clickeable (abre full); fail-soft (URL vencida/firma fallida → placeholder); `null` → "sin selfie" honesto.
 */
function EnrolSelfiePreview({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  const showImage = url !== null && !broken;
  return (
    <div className="flex items-center gap-3 border-b border-border pb-4">
      {showImage ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
          <img
            src={url}
            alt="Selfie del registro del conductor"
            className="size-24 rounded-xl border border-border object-cover ring-1 ring-inset ring-white/5"
            onError={() => setBroken(true)}
          />
        </a>
      ) : (
        <div className="grid size-24 shrink-0 place-items-center rounded-xl border border-border bg-surface text-ink-muted">
          <ScanFace className="size-8" aria-hidden />
        </div>
      )}
      <div>
        <dt className="text-xs font-medium text-ink-muted">Selfie del registro</dt>
        <p className="mt-0.5 text-xs text-ink-muted">
          {showImage
            ? 'Compará a ojo contra el DNI y la licencia.'
            : url === null
              ? 'Sin selfie guardada.'
              : 'No se pudo mostrar (enlace vencido o archivo dañado).'}
        </p>
      </div>
    </div>
  );
}

function FaceMatchBindings({ driver }: { driver: DriverDetail }) {
  const dniMatch = useDniFaceMatch();
  const licenseMatch = useLicenseFaceMatch();
  return (
    <div className="space-y-3">
      <FaceMatchPanel driver={driver} doc={FACE_MATCH_DNI} mutation={dniMatch} />
      <FaceMatchPanel driver={driver} doc={FACE_MATCH_LICENSE} mutation={licenseMatch} />
    </div>
  );
}

/**
 * F3 · destrabe biométrico por la CENTRAL (regla #1 driver: "solo central destraba"). Botón de remediación
 * idempotente: limpia el lockout del gate de turno (3 fallos/1h) y el cooldown de abuso del enrol. NO es
 * destructivo (habilita, no borra) → sin confirm pesado, toast de éxito. El gate REAL es server-side.
 */
function BiometricUnlockAction({ driverId }: { driverId: string }) {
  const { toast } = useToast();
  const unlock = useUnlockBiometric();
  const run = async () => {
    try {
      await unlock.mutateAsync({ id: driverId });
      toast({ tone: 'success', title: 'Verificación biométrica destrabada' });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'No se pudo destrabar la verificación',
        description: error instanceof ApiError ? error.message : undefined,
      });
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
      <div>
        <dt className="text-xs text-ink-muted">Bloqueo por intentos fallidos</dt>
        <p className="mt-0.5 text-xs text-ink-muted">
          Destrabá si el conductor reporta su verificación bloqueada (turno o registro).
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void run()}
        disabled={unlock.isPending}
      >
        <Unlock className="size-4" aria-hidden />
        Destrabar
      </Button>
    </div>
  );
}

type ReadyState = 'ok' | 'pending' | 'warn';

/** Mapea el FaceMatchStatus tipado a un estado de readiness (sin strings mágicos: usa el enum local). */
function faceReadiness(status: DriverDetail['biometric']['dniFaceMatchStatus']): ReadyState {
  return status === FaceMatchStatus.MATCHED
    ? 'ok'
    : status === FaceMatchStatus.NO_MATCH
      ? 'warn'
      : 'pending';
}

/**
 * Readiness del liveness PASIVO: PASSED → ok (el anti-spoofing corrió y dio viva); DEGRADED → warn (enroló SIN
 * anti-spoofing — el operador debe saberlo); NOT_RUN → pending (aún no enroló biometría).
 */
function livenessReadiness(status: DriverDetail['biometric']['livenessStatus']): ReadyState {
  return status === PassiveLivenessStatus.PASSED
    ? 'ok'
    : status === PassiveLivenessStatus.DEGRADED
      ? 'warn'
      : 'pending';
}

/** Texto legible del liveness para la ficha (status + score 0..1 de la clase viva). */
function livenessLabel(
  status: DriverDetail['biometric']['livenessStatus'],
  score: number | null,
): string {
  if (status === PassiveLivenessStatus.PASSED) {
    return score != null ? `Vivo · ${score.toFixed(2)}` : 'Vivo';
  }
  if (status === PassiveLivenessStatus.DEGRADED) return 'Degradado · sin anti-spoofing';
  return 'No enrolado';
}

/**
 * Hint corto del gate de ITV por motivo de invalidez (presentación, NO lógica: el gate usa el booleano
 * `inspection.current`). Espeja los motivos que clasifica fleet (NONE/NOT_PASSED/OVERDUE/NO_VEHICLE).
 */
const ITV_HINT: Record<string, string> = {
  NONE: 'El vehículo no tiene ITV registrada.',
  NOT_PASSED: 'La ITV del vehículo está reprobada.',
  OVERDUE: 'La ITV del vehículo está vencida.',
  NO_VEHICLE: 'El conductor no tiene un vehículo operable.',
};

/** Chip de readiness para la barra de aprobación: verde ok / ámbar-danger warn / neutro pendiente. */
function ReadyChip({ label, state }: { label: string; state: ReadyState }) {
  const cfg = {
    ok: { Icon: Check, cls: 'bg-success/10 text-success' },
    warn: { Icon: AlertTriangle, cls: 'bg-danger/10 text-danger' },
    pending: { Icon: Circle, cls: 'bg-surface-2 text-ink-subtle' },
  } as const;
  const { Icon, cls } = cfg[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Barra de aprobación: la acción PRIMARIA de la pantalla, al frente. Muestra el READINESS de los gates
 * que el operador necesita (ambos face-match ejecutados = el gate dual server-side de `approve()`) y la
 * CTA "Aprobar conductor" GATEADA: deshabilitada con el motivo hasta correr ambos bindings. La UI REFLEJA
 * el gate (no autoriza); el bff revalida @Roles + el gate dual + los documentos obligatorios.
 */
function ApprovalBar({
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
  // TODOS los gates server-side de `approve()` REFLEJADOS (la UI no autoriza, refleja): face-match dual +
  // liveness PASSED + documentos obligatorios VALID + ITV vigente. canApprove exige los cuatro → el botón
  // ya NO se habilita a ciegas. El bff revalida igual @Roles + los mismos gates (computeApprovalGates).
  const livenessPassed = bio.livenessStatus === PassiveLivenessStatus.PASSED;
  const facesRun = bio.dniFaceMatchedAt != null && bio.licenseFaceMatchedAt != null;
  const canApprove = facesRun && livenessPassed && readiness.documentsValid && itv.current;
  // Motivo HONESTO del bloqueo, en el ORDEN en que el operador lo resuelve: anti-spoofing (re-enrol) →
  // face-match (cotejo, en esta pantalla) → documentos (validar en la ficha) → ITV (registrar acá mismo).
  const blockReason = !livenessPassed
    ? 'El anti-spoofing del enrol no corrió (enrol degradado); el conductor debe re-enrolar su biometría.'
    : !facesRun
      ? 'Corré ambos face-match para habilitar.'
      : !readiness.documentsValid
        ? `Faltan documentos válidos: ${readiness.missingDocuments.join(', ')}. Validalos abajo en Documentos.`
        : !itv.current
          ? (ITV_HINT[itv.invalidReason ?? ''] ?? 'Falta la inspección técnica (ITV) del vehículo.')
          : '';

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between lg:px-5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">Revisión de alta</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ReadyChip label="Biometría enrolada" state={bio.faceEnrolledAt ? 'ok' : 'pending'} />
          <ReadyChip label="Anti-spoofing" state={livenessReadiness(bio.livenessStatus)} />
          <ReadyChip label="Rostro vs DNI" state={faceReadiness(bio.dniFaceMatchStatus)} />
          <ReadyChip label="Rostro vs licencia" state={faceReadiness(bio.licenseFaceMatchStatus)} />
          <ReadyChip label="Documentos" state={readiness.documentsValid ? 'ok' : 'warn'} />
          <ReadyChip label="ITV" state={itv.current ? 'ok' : 'warn'} />
        </div>
      </div>

      {can(user, 'drivers:approve') ? (
        <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
          {/* Puente a la ITV: si es lo que bloquea y hay vehículo operable, el operador la registra ACÁ MISMO
              (vehículo precargado, sin pegar uuids ni salir de la pantalla). Al registrarla, refresca el detalle
              → el chip ITV pasa a verde y "Aprobar" se habilita. Sin vehículo no se ofrece (no hay qué inspeccionar). */}
          {!itv.current && (itv.vehicleId || driver.vehicle) ? (
            <CreateInspectionDialog
              vehicleId={itv.vehicleId ?? driver.vehicle?.id}
              vehicleLabel={driver.vehicle?.plate ?? undefined}
              onCreated={onItvRegistered}
              trigger={
                <Button variant="secondary">
                  <Car className="size-4" aria-hidden />
                  Registrar ITV
                </Button>
              }
            />
          ) : null}
          <div className="flex items-center gap-2">
            {/* Rechazar: MOTIVO (el conductor lo VE en su app) + MFA (BR-S07). Disponible aunque falten gates
                (el operador puede rechazar un alta incompleta/dudosa en cualquier momento). */}
            <StepUpDialog
              trigger={
                <Button variant="danger">
                  <X className="size-4" aria-hidden />
                  Rechazar
                </Button>
              }
              title="Rechazar conductor"
              description="El conductor verá el motivo para corregir y reenviar. Acción sensible: requiere tu MFA. Queda auditada."
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
            {/* Aprobar exige step-up MFA (BR-S07 · @RequireStepUpMfa en el bff). Gated por canApprove (refleja
                los gates server-side); el TOTP se pide en prod, se salta en dev (espeja el StepUpMfaGuard). */}
            <StepUpDialog
              trigger={
                <Button variant="primary" disabled={!canApprove}>
                  <Check className="size-4" aria-hidden />
                  Aprobar conductor
                </Button>
              }
              title="Aprobar conductor"
              description="Habilitás al conductor para operar. Acción sensible: requiere tu MFA. El servidor revalida documentos + ITV."
              confirmLabel="Aprobar"
              onVerified={async () => {
                await decision.mutateAsync({ id: driver.id, decision: 'approve' });
                toast({ tone: 'success', title: 'Conductor aprobado' });
              }}
            />
          </div>
          {!canApprove ? <span className="text-xs text-ink-muted">{blockReason}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Traduce el ApiError del borrado a un mensaje AMIGABLE para mostrar dentro del ConfirmDialog (irreversible).
 * - 409 (ConflictError, BR-S06): el conductor tiene historial operativo → el backend ya manda un texto
 *   amigable en español sobre el flujo de "derecho al olvido"; lo reusamos tal cual (no lo crudeamos).
 * - 403: rol insuficiente (no SUPERADMIN) o MFA no fresca → mensaje claro propio (el server no detalla por seguridad).
 * - Resto/red: fallback genérico.
 */
function friendlyDeleteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return (
        error.message ||
        'Este conductor tiene historial operativo y no puede borrarse. Usá el flujo de derecho al olvido (BR-S06).'
      );
    }
    if (error.status === 403) {
      return 'No tenés permiso para borrar conductores, o tu verificación MFA no está fresca. Reautenticate e intentá de nuevo.';
    }
    return error.message || 'No se pudo eliminar al conductor.';
  }
  return 'No se pudo eliminar al conductor.';
}

/**
 * Eliminar al CONDUCTOR en cascada (DELETE /ops/drivers/:id vía useDeleteDriver). Acción IRREVERSIBLE,
 * visible SOLO a SUPERADMIN (gateada por `drivers:delete`; el bff revalida @Roles(SUPERADMIN) + step-up MFA).
 * El ConfirmDialog exige escribir el nombre del conductor (o "ELIMINAR" si no hay nombre) para habilitar el
 * botón de confirmar. On success: toast + redirect a /ops/drivers (la cache de drivers se invalida en el hook).
 * On error captura el throw del mutateAsync y lo muestra como mensaje amigable (409 BR-S06 / 403) en el diálogo.
 */
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

  if (!can(user, 'drivers:delete')) {
    return null;
  }

  const who = driverName?.trim() ? driverName.trim() : 'este conductor';

  // Eliminar es acción sensible → exige step-up MFA (el bff tiene @RequireStepUpMfa). El StepUpDialog
  // pide el TOTP, llama /auth/step-up (eleva la MFA) y SOLO entonces ejecuta el borrado. El TOTP es la
  // confirmación fuerte e irreversible (mismo patrón que video/live). El diálogo se cierra antes de
  // onVerified, así que el resultado del borrado se reporta por toast (no inline).
  return (
    <StepUpDialog
      trigger={
        <Button
          size="sm"
          variant="ghost"
          className="size-9 px-0 text-ink-subtle hover:bg-danger/10 hover:text-danger"
          aria-label="Eliminar conductor"
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      }
      title="Eliminar conductor"
      description={`Vas a borrar a ${who}: su usuario, documentos y archivos en cascada. Es IRREVERSIBLE. Ingresá tu código TOTP para confirmar.`}
      onVerified={async () => {
        try {
          await remove.mutateAsync({ id: driverId });
          toast({ tone: 'success', title: 'Conductor eliminado' });
          router.push('/ops/drivers');
        } catch (error) {
          toast({ tone: 'danger', title: 'No se pudo eliminar', description: friendlyDeleteError(error) });
        }
      }}
    />
  );
}
