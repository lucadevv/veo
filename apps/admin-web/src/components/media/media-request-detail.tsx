'use client';

import { Lock, PlayCircle, ShieldX, Clock, Users } from 'lucide-react';
import type { MediaAccessRequestView } from '@/lib/api/schemas';
import { ROLE_LABELS } from '@/lib/roles';
import { dateTime } from '@/lib/formatters';
import { StatusPill } from '@/components/ui/status-pill';
import { MediaActions } from '@/components/media/media-actions';

/** Iniciales (2) para el avatar del solicitante; sin texto → "•". */
function initials(text: string): string {
  const p = text.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || (text[0]?.toUpperCase() ?? '•');
}

/** Estado visual de la tarjeta oscura del video según el estado de la solicitud (fiel al frame: lock/play/etc). */
const VIDEO_CARD: Record<
  MediaAccessRequestView['status'],
  { icon: typeof Lock; title: string }
> = {
  PENDING: { icon: Lock, title: 'Video protegido · requiere aprobación' },
  APPROVED: { icon: PlayCircle, title: 'Acceso aprobado · grabación disponible' },
  REJECTED: { icon: ShieldX, title: 'Solicitud rechazada' },
  EXPIRED: { icon: Clock, title: 'Solicitud expirada' },
};

/**
 * Detalle de una solicitud de acceso a video (fiel al frame rMKhS · panel derecho del master-detail):
 * solicitante (STAFF · accountability de la doble-auth), tarjeta oscura del video protegido, ficha
 * label/valor (objetivo · motivo · retención), chip de doble aprobación de Cumplimiento, y las acciones a lo
 * ancho (aprobar/rechazar/reproducir) que EXIGEN step-up MFA — reusadas de `MediaActions` (lógica intacta).
 * Datos REALES del contrato; el "Rango" del segmento (frame) se OMITE honesto: requiere la lectura AUDITADA de
 * segmentos (no debe auto-dispararse al seleccionar una fila).
 */
export function MediaRequestDetail({ request }: { request: MediaAccessRequestView }) {
  const who = request.requesterName ?? request.requesterEmail;
  const roleLabel = request.requesterRole
    ? (ROLE_LABELS[request.requesterRole] ?? request.requesterRole)
    : null;
  const card = VIDEO_CARD[request.status];
  const CardIcon = card.icon;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-5">
      {/* Encabezado: id + estado */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-lg font-semibold text-ink">Solicitud #{request.id.slice(0, 8)}</h2>
        <StatusPill status={request.status} />
      </div>

      {/* Solicitante (staff · quién pide ver el video) */}
      <div className="flex items-center gap-3 rounded-2xl border border-black/[0.05] bg-bg p-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent/10 text-[13px] font-semibold text-accent">
          {initials(who)}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-ink">{who}</span>
          <span className="truncate text-xs text-ink-subtle">
            {roleLabel ? `${roleLabel} · ` : ''}
            {request.requesterEmail}
          </span>
        </div>
      </div>

      {/* Tarjeta oscura del video (protegido / aprobado / rechazado / expirado) */}
      <div className="flex flex-col items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-b from-[#20304A] to-[#0A0B0F] p-9 text-center">
        <CardIcon className="size-8 text-white/70" aria-hidden />
        <p className="text-sm font-medium text-white/90">{card.title}</p>
      </div>

      {/* Ficha label/valor (fiel al frame: etiqueta izq · valor der) */}
      <dl className="flex flex-col gap-3">
        <Row label="Objetivo" value={`Viaje #${request.tripId.slice(0, 8)}`} mono />
        <Row label="Motivo" value={request.reason} />
        <Row label="Solicitado" value={dateTime(request.requestedAt)} />
        {request.decidedAt ? <Row label="Decidido" value={dateTime(request.decidedAt)} /> : null}
        <Row label="Retención" value="Copia firmada, expira 72 h" />
      </dl>

      {/* Chip de doble aprobación (fiel al frame · texto HONESTO: la doble-auth VEO es solicitante≠aprobador + MFA,
          no un contador "1 de 2" — el backend aprueba con un solo operador distinto del solicitante). */}
      <div className="flex items-center gap-2.5 rounded-xl border border-accent/20 bg-accent/[0.06] px-3.5 py-3 text-accent">
        <Users className="size-4 shrink-0" aria-hidden />
        <span className="text-[13px] font-medium">
          Requiere aprobación de Cumplimiento (otro operador · MFA fresca)
        </span>
      </div>

      {/* Acciones a lo ancho (aprobar/rechazar/reproducir · step-up MFA · lógica reusada de MediaActions) */}
      <MediaActions request={request} stacked />
    </div>
  );
}

/** Fila label/valor: etiqueta a la izquierda, valor a la derecha (alineado a la derecha, puede envolver). */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-sm text-ink-muted">{label}</dt>
      <dd className={`text-right text-sm font-medium text-ink ${mono ? 'font-mono tabular' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
