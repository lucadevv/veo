'use client';

import { useState } from 'react';
import { Check, ImageOff, RefreshCw, X } from 'lucide-react';
import type { AdminDriverDocument, FleetDocumentTypeValue } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useDocumentReview } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Visor de documentos del conductor para la revisión de onboarding (aprobar/rechazar por documento).
 * DESACOPLADO de la fuente de datos: recibe los documentos ya resueltos + el estado de carga + un
 * `onReload` que el contenedor cablea a `refetch()` del detalle. Así se reusa tal cual en Flota →
 * Documentos: basta pasarle otra lista de `AdminDriverDocument` y otro `onReload`.
 *
 * Las `url` son presigned GET (TTL 120s server-side): se vencen. Por eso CADA imagen tiene su propio
 * fallback "imagen rota / URL vencida" con botón Recargar → `onReload` re-pide el detalle y renueva
 * todas las firmas de una. La decisión de aprobar NO depende de poder ver el archivo (el gate valida
 * el ESTADO del doc, no su URL); el visor solo facilita la inspección visual.
 */

/**
 * Label legible por tipo de documento. Record TIPADO contra el enum del contrato
 * (`FleetDocumentTypeValue`): si el contrato suma un tipo y no se mapea acá, es error de compilación —
 * cero magic strings, cero `=== 'LICENSE_A1'` suelto.
 */
const DOCUMENT_TYPE_LABEL: Record<FleetDocumentTypeValue, string> = {
  LICENSE_A1: 'Licencia de conducir A1',
  SOAT: 'SOAT',
  PROPERTY_CARD: 'Tarjeta de propiedad',
  BACKGROUND_CHECK: 'Certificado de antecedentes',
  ITV: 'Revisión técnica (ITV)',
  AMBULANCE_OPERATOR: 'Operador de ambulancia',
  TOW_OPERATOR: 'Operador de grúa',
  MECHANIC_CERT: 'Certificado de mecánico',
  VEHICLE_PHOTO: 'Foto del vehículo',
};

interface DocumentViewerProps {
  documents: AdminDriverDocument[];
  /** Estado de carga del detalle que provee los documentos. */
  isLoading: boolean;
  isError: boolean;
  /** Re-pide el detalle: reintento de error Y renovación de presigned URLs vencidas (TTL 120s). */
  onReload: () => void;
  /** Está re-pidiendo el detalle (fetching en curso): deshabilita los botones Recargar. */
  isReloading?: boolean;
  /** ID del conductor dueño de los documentos: viaja a la mutación de review para invalidar su detalle. */
  driverId: string;
}

export function DocumentViewer({
  documents,
  isLoading,
  isError,
  onReload,
  isReloading = false,
  driverId,
}: DocumentViewerProps) {
  // Estado 1: cargando.
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  // Estado 2: error de carga del detalle → reintento (re-pide el detalle).
  if (isError) {
    return <ErrorState onRetry={onReload} />;
  }

  // Estado 3: vacío (el conductor no tiene documentos cargados).
  if (documents.length === 0) {
    return (
      <EmptyState
        icon={<ImageOff className="size-6" aria-hidden />}
        title="Sin documentos"
        description="Este conductor todavía no subió documentos para revisar."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {documents.map((doc) => (
        <DocumentCard
          key={doc.id}
          doc={doc}
          driverId={driverId}
          onReload={onReload}
          isReloading={isReloading}
        />
      ))}
    </div>
  );
}

function DocumentCard({
  doc,
  driverId,
  onReload,
  isReloading,
}: {
  doc: AdminDriverDocument;
  driverId: string;
  onReload: () => void;
  isReloading: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <span className="text-sm font-semibold text-ink">{DOCUMENT_TYPE_LABEL[doc.type]}</span>
        <StatusPill status={doc.status} />
      </div>

      <DocumentImage doc={doc} onReload={onReload} isReloading={isReloading} />

      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-muted">Vencimiento</span>
          <span className="text-ink tabular">{dateTime(doc.expiresAt)}</span>
        </div>
        {/* El motivo de rechazo es read-only acá: lo persiste fleet cuando exista (ver DEUDA en las acciones). */}
        {doc.rejectionReason ? (
          <p className="text-sm text-danger">Motivo: {doc.rejectionReason}</p>
        ) : null}
        <DocumentReviewActions doc={doc} driverId={driverId} />
      </CardContent>
    </Card>
  );
}

/**
 * Imagen del documento con su propio ciclo de vida de error. Estado 4: la presigned URL puede venir
 * `null` (archivo no subido aún) o vencerse (TTL 120s) → `onError` del <img> levanta el fallback con
 * botón Recargar, que dispara `onReload` (re-pide el detalle → renueva la firma). `key` por url para
 * resetear el estado de error cuando llega una URL nueva tras recargar.
 */
function DocumentImage({
  doc,
  onReload,
  isReloading,
}: {
  doc: AdminDriverDocument;
  onReload: () => void;
  isReloading: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const unavailable = doc.url === null || broken;

  if (unavailable) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-3 bg-surface-2 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-lg bg-surface text-ink-muted">
          <ImageOff className="size-6" aria-hidden />
        </div>
        <p className="text-sm text-ink-muted">
          {doc.url === null
            ? 'El archivo aún no fue subido.'
            : 'No se pudo cargar la imagen (el enlace pudo vencer).'}
        </p>
        {doc.url !== null ? (
          <Button variant="secondary" size="sm" loading={isReloading} onClick={onReload}>
            <RefreshCw className="size-4" aria-hidden />
            Recargar
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <a
      href={doc.url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-surface-2"
    >
      <img
        // `key` ligado a la url: al recargar, una firma nueva remonta el <img> y limpia el estado broken.
        key={doc.url}
        src={doc.url ?? undefined}
        alt={DOCUMENT_TYPE_LABEL[doc.type]}
        className="h-56 w-full object-contain"
        onError={() => setBroken(true)}
      />
    </a>
  );
}

/**
 * Aprobar/rechazar el DOCUMENTO. Gateado por `fleet:review` (la UI refleja, no autoriza; el bff
 * revalida @Roles). Solo se revisa lo que está `PENDING_REVIEW` (enum tipado del contrato). Reusa la
 * mutación `useDocumentReview` (POST /fleet/documents/:id/review {decision}).
 */
function DocumentReviewActions({ doc, driverId }: { doc: AdminDriverDocument; driverId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const review = useDocumentReview();

  // `doc.status` es el enum tipado (fleetDocumentStatus): comparar contra un literal fuera del set es
  // error de compilación, no un magic string mudo.
  if (!can(user, 'fleet:review') || doc.status !== 'PENDING_REVIEW') {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="primary">
            <Check className="size-4" aria-hidden />
            Aprobar
          </Button>
        }
        title="Aprobar documento"
        description="Confirmas que el documento es válido y vigente."
        confirmLabel="Aprobar"
        onConfirm={async () => {
          await review.mutateAsync({ id: doc.id, decision: 'approve', driverId });
          toast({ tone: 'success', title: 'Documento aprobado' });
        }}
      />
      {/* M5: el rechazo PIDE el motivo (withReason, obligatorio) → fleet lo persiste y el conductor lo VE. */}
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar documento"
        description="El documento quedará rechazado. Indicá el motivo: el conductor lo verá para corregir."
        confirmLabel="Rechazar"
        variant="danger"
        withReason
        reasonLabel="Motivo del rechazo"
        onConfirm={async (reason) => {
          await review.mutateAsync({ id: doc.id, decision: 'reject', driverId, reason });
          toast({ tone: 'success', title: 'Documento rechazado' });
        }}
      />
    </div>
  );
}
