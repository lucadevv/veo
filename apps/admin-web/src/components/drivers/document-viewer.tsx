'use client';

import { useState } from 'react';
import {
  BadgeCheck,
  Car,
  Check,
  ImageOff,
  type LucideIcon,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import type {
  AdminDocumentImage,
  AdminDriverDocument,
  DocumentSideValue,
  FleetDocumentTypeValue,
} from '@/lib/api/schemas';
import { date } from '@/lib/formatters';
import { useDocumentReview } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
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
  DNI: 'DNI (Documento de identidad)',
};

/**
 * Label por CARA (sub-lote 3A · múltiples imágenes). Record TIPADO contra `DocumentSideValue`: sumar una
 * cara al contrato sin mapearla acá es error de compilación — cero magic strings (`=== 'FRONT'` suelto).
 */
const DOCUMENT_SIDE_LABEL: Record<DocumentSideValue, string> = {
  FRONT: 'Anverso',
  BACK: 'Reverso',
  SINGLE: 'Documento',
};

/**
 * CATEGORÍA del documento (quién es su DUEÑO). El contrato `adminDriverDocument` NO trae `ownerType`, así que
 * la DERIVAMOS del `type` con un Record EXHAUSTIVO: sumar un tipo de doc al contrato sin categorizarlo acá es
 * error de compilación. Cero magic strings. Esto es lo que mata el "todo en una lista plana" — el operador ve
 * los docs PERSONALES separados de los DEL VEHÍCULO.
 */
const DocumentCategory = {
  PERSONAL: 'PERSONAL',
  VEHICLE: 'VEHICLE',
  CERTIFICATION: 'CERTIFICATION',
} as const;
type DocumentCategory = (typeof DocumentCategory)[keyof typeof DocumentCategory];

const DOCUMENT_CATEGORY: Record<FleetDocumentTypeValue, DocumentCategory> = {
  DNI: DocumentCategory.PERSONAL,
  LICENSE_A1: DocumentCategory.PERSONAL,
  BACKGROUND_CHECK: DocumentCategory.PERSONAL,
  SOAT: DocumentCategory.VEHICLE,
  PROPERTY_CARD: DocumentCategory.VEHICLE,
  VEHICLE_PHOTO: DocumentCategory.VEHICLE,
  ITV: DocumentCategory.VEHICLE,
  AMBULANCE_OPERATOR: DocumentCategory.CERTIFICATION,
  TOW_OPERATOR: DocumentCategory.CERTIFICATION,
  MECHANIC_CERT: DocumentCategory.CERTIFICATION,
};

/** Meta de cada categoría en ORDEN de despliegue (personal → vehículo → certificaciones). */
const CATEGORY_META: { key: DocumentCategory; label: string; hint: string; Icon: LucideIcon }[] = [
  {
    key: DocumentCategory.PERSONAL,
    label: 'Documentos personales',
    hint: 'Identidad del conductor',
    Icon: User,
  },
  {
    key: DocumentCategory.VEHICLE,
    label: 'Documentos del vehículo',
    hint: 'Habilitación del auto',
    Icon: Car,
  },
  {
    key: DocumentCategory.CERTIFICATION,
    label: 'Certificaciones de operador',
    hint: 'Verticales especiales',
    Icon: BadgeCheck,
  },
];

/** Orden estable DENTRO de cada categoría (Record exhaustivo: DNI antes que licencia, SOAT antes que tarjeta…). */
const DOCUMENT_TYPE_ORDER: Record<FleetDocumentTypeValue, number> = {
  DNI: 0,
  LICENSE_A1: 1,
  BACKGROUND_CHECK: 2,
  SOAT: 3,
  PROPERTY_CARD: 4,
  VEHICLE_PHOTO: 5,
  ITV: 6,
  AMBULANCE_OPERATOR: 7,
  TOW_OPERATOR: 8,
  MECHANIC_CERT: 9,
};

/**
 * Estados del doc (= `fleetDocumentStatus` del contrato). Const local tipado para comparar SIN magic strings
 * (`=== DocStatus.PENDING_REVIEW` en vez de `=== 'PENDING_REVIEW'`), sin importar shared-types en el cliente.
 */
const DocStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  VALID: 'VALID',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
} as const;

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

  // Estado 4: AGRUPADO por categoría (personal / vehículo / certificación), ordenado dentro de cada una. Esto
  // reemplaza la lista plana que mezclaba DNI/licencia con SOAT/tarjeta/foto — el operador escanea por dueño.
  const byCategory = new Map<DocumentCategory, AdminDriverDocument[]>();
  for (const doc of documents) {
    const cat = DOCUMENT_CATEGORY[doc.type];
    const list = byCategory.get(cat);
    if (list) list.push(doc);
    else byCategory.set(cat, [doc]);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => DOCUMENT_TYPE_ORDER[a.type] - DOCUMENT_TYPE_ORDER[b.type]);
  }

  return (
    <div className="space-y-8">
      {CATEGORY_META.map(({ key, label, hint, Icon }) => {
        const docs = byCategory.get(key);
        if (!docs || docs.length === 0) return null;
        return (
          <DocumentSection
            key={key}
            label={label}
            hint={hint}
            Icon={Icon}
            docs={docs}
            driverId={driverId}
            onReload={onReload}
            isReloading={isReloading}
          />
        );
      })}
    </div>
  );
}

/**
 * Una SECCIÓN de categoría: encabezado (icono + label + conteo) con un resumen at-a-glance del estado del
 * grupo a la derecha, y la grilla de tarjetas. Solo se renderiza si la categoría tiene documentos.
 */
function DocumentSection({
  label,
  hint,
  Icon,
  docs,
  driverId,
  onReload,
  isReloading,
}: {
  label: string;
  hint: string;
  Icon: LucideIcon;
  docs: AdminDriverDocument[];
  driverId: string;
  onReload: () => void;
  isReloading: boolean;
}) {
  return (
    <section>
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-muted">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">{label}</h3>
            <p className="text-xs text-ink-subtle">
              {hint} · {docs.length} {docs.length === 1 ? 'documento' : 'documentos'}
            </p>
          </div>
        </div>
        <SectionSummary docs={docs} />
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {docs.map((doc) => (
          <DocumentCard
            key={doc.id}
            doc={doc}
            driverId={driverId}
            onReload={onReload}
            isReloading={isReloading}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Resumen at-a-glance del estado de una sección, por PRIORIDAD de acción: si hay docs por revisar (acción
 * pendiente del operador) gana el ámbar; si no, lo que tiene PROBLEMA (vencido/rechazado) gana el rojo; si
 * todo está vigente, verde "En regla". Así el operador sabe DÓNDE mirar sin abrir cada tarjeta.
 */
function SectionSummary({ docs }: { docs: AdminDriverDocument[] }) {
  const pending = docs.filter((d) => d.status === DocStatus.PENDING_REVIEW).length;
  const problem = docs.filter(
    (d) => d.status === DocStatus.EXPIRED || d.status === DocStatus.REJECTED,
  ).length;

  if (pending > 0) {
    return <Badge tone="warn">{pending} por revisar</Badge>;
  }
  if (problem > 0) {
    return <Badge tone="danger">{problem} con problema</Badge>;
  }
  return <Badge tone="success">En regla</Badge>;
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

      <DocumentGallery doc={doc} onReload={onReload} isReloading={isReloading} />

      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-muted">Vencimiento</span>
          <span className="text-ink tabular">{date(doc.expiresAt)}</span>
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
 * Galería de las N imágenes del documento (sub-lote 3A · múltiples imágenes). DNI → anverso+reverso lado
 * a lado; foto de vehículo → N tiles; documento de 1 cara → un solo tile (idéntico al render previo).
 *
 * Backward-compat: si el doc NO trae `images` (contrato viejo o sin archivo) pero sí el `url` legacy, se
 * sintetiza una imagen SINGLE con ese url. Si no hay ninguna fuente, se muestra el fallback "sin archivo".
 */
function DocumentGallery({
  doc,
  onReload,
  isReloading,
}: {
  doc: AdminDriverDocument;
  onReload: () => void;
  isReloading: boolean;
}) {
  // Normaliza la fuente: las N imágenes reales o, si no hay, el legacy `url` como una sola cara SINGLE.
  const images: AdminDocumentImage[] =
    doc.images.length > 0
      ? doc.images
      : doc.url !== null
        ? [{ side: 'SINGLE', order: 0, url: doc.url }]
        : [];

  // Sin ninguna imagen: el archivo aún no se subió (mismo fallback que antes, sin botón Recargar).
  if (images.length === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-3 bg-surface-2 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-lg bg-surface text-ink-muted">
          <ImageOff className="size-6" aria-hidden />
        </div>
        <p className="text-sm text-ink-muted">El archivo aún no fue subido.</p>
      </div>
    );
  }

  // 1 imagen → ocupa el ancho completo (idéntico al render histórico). 2+ → grilla lado a lado.
  const single = images.length === 1;

  return (
    <div className={single ? 'bg-surface-2' : 'grid grid-cols-2 gap-px bg-border'}>
      {images.map((image) => (
        <DocumentImageTile
          // `key` por (side+order+url): firma nueva tras recargar remonta el tile y limpia su estado broken.
          key={`${image.side}-${image.order}-${image.url ?? 'null'}`}
          image={image}
          docTypeLabel={DOCUMENT_TYPE_LABEL[doc.type]}
          showSideLabel={!single}
          onReload={onReload}
          isReloading={isReloading}
        />
      ))}
    </div>
  );
}

/**
 * Un tile de imagen (una cara) con su propio ciclo de vida de error. La presigned URL puede venir `null`
 * (firma fallida, fail-soft) o vencerse (TTL 120s) → `onError` del <img> levanta el fallback con botón
 * Recargar, que dispara `onReload` (re-pide el detalle → renueva TODAS las firmas de una).
 */
function DocumentImageTile({
  image,
  docTypeLabel,
  showSideLabel,
  onReload,
  isReloading,
}: {
  image: AdminDocumentImage;
  docTypeLabel: string;
  showSideLabel: boolean;
  onReload: () => void;
  isReloading: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const unavailable = image.url === null || broken;
  const alt = showSideLabel ? `${docTypeLabel} · ${DOCUMENT_SIDE_LABEL[image.side]}` : docTypeLabel;

  return (
    <div className="relative bg-surface-2">
      {showSideLabel ? (
        <span className="absolute left-2 top-2 z-10 rounded bg-surface/90 px-2 py-0.5 text-xs font-medium text-ink-muted">
          {DOCUMENT_SIDE_LABEL[image.side]}
        </span>
      ) : null}

      {unavailable ? (
        <div className="flex h-56 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="grid size-12 place-items-center rounded-lg bg-surface text-ink-muted">
            <ImageOff className="size-6" aria-hidden />
          </div>
          <p className="text-sm text-ink-muted">
            No se pudo mostrar la imagen (enlace vencido o archivo dañado).
          </p>
          <Button variant="secondary" size="sm" loading={isReloading} onClick={onReload}>
            <RefreshCw className="size-4" aria-hidden />
            Recargar
          </Button>
        </div>
      ) : (
        <a
          href={image.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <img
            key={image.url}
            src={image.url ?? undefined}
            alt={alt}
            className="h-56 w-full object-contain"
            onError={() => setBroken(true)}
          />
        </a>
      )}
    </div>
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

  // `doc.status` es el enum tipado (fleetDocumentStatus): comparado contra el const tipado `DocStatus` (no un
  // literal mudo). Solo se revisa lo que está PENDING_REVIEW.
  if (!can(user, 'fleet:review') || doc.status !== DocStatus.PENDING_REVIEW) {
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
