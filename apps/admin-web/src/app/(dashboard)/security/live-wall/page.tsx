'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Film, Lock, Radio, Video, X } from 'lucide-react';
import { useLiveCabins } from '@/lib/api/queries';
import type { LiveViewerToken } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { LiveAccessDialog } from '@/components/live/live-access-dialog';
import { LiveCabinViewer } from '@/components/live/live-cabin-viewer';
import { CameraTile } from '@/components/live/camera-tile';

/**
 * Muro de cámaras EN VIVO (frame "Cámaras en vivo" · T/CameraTile): cabinas de los viajes en curso. Cada tile
 * es un placeholder oscuro tipo feed — abrir la cámara exige doble-auth (motivo + step-up MFA) y queda auditado
 * server-side (media-bff + media-service re-autorizan por rol + MFA fresca). Gate de presentación `live:view`.
 * Multiview: varias cámaras abiertas a la vez, cada una con su token solo-suscripción.
 */
export default function LiveWallPage() {
  const user = useSession();
  const query = useLiveCabins();
  // tripId → grant activo. Abrir una cámara es por-viaje (cada una con su doble-auth); cerrar la quita.
  const [grants, setGrants] = useState<Record<string, LiveViewerToken>>({});
  // Deep-link desde el detalle de un pánico (`?trip=`): resalta y prioriza esa cabina. Antes el param se
  // ignoraba y el operador caía en el muro completo sin contexto (flujo de seguridad roto).
  const focusTrip = useSearchParams().get('trip');
  const focusRef = useRef<HTMLDivElement>(null);

  // Cuando llega el deep-link y la cabina existe, la trae a la vista (por si el muro es largo).
  useEffect(() => {
    if (focusTrip && focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusTrip, query.data]);

  if (!can(user, 'live:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Cámaras en vivo"
          breadcrumbs={[{ label: 'Seguridad' }, { label: 'Cámaras en vivo' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol de Cumplimiento o Administrador para el muro de cámaras en vivo."
        />
      </div>
    );
  }

  const rawCabins = query.data ?? [];
  // La cabina del pánico va PRIMERA (visible sin scroll en el muro).
  const cabins = focusTrip
    ? [...rawCabins].sort((a, b) => (a.tripId === focusTrip ? -1 : b.tripId === focusTrip ? 1 : 0))
    : rawCabins;
  const focusInCabins = !!focusTrip && rawCabins.some((c) => c.tripId === focusTrip);
  // El viaje del pánico ya NO transmite en vivo (terminó / dejó de publicar) → ofrecer la grabación, no dejar
  // al operador sin salida.
  const focusGone = !!focusTrip && !focusInCabins && !query.isLoading && !query.isError;

  // Cabinas con un VISOR ABIERTO cuyo viaje ya no está en la lista en vivo (terminó / dejó de publicar). En vez de
  // hacer desaparecer el visor sin aviso, se renderiza un cierre honesto "El viaje finalizó" con botón de cerrar.
  const cabinIds = new Set(cabins.map((c) => c.tripId));
  const endedGrantIds = Object.keys(grants).filter((id) => !cabinIds.has(id));

  function closeCamera(tripId: string) {
    setGrants((prev) => {
      const next = { ...prev };
      delete next[tripId];
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Cámaras en vivo"
        description="Cabinas de viajes en curso. Abrir una cámara exige motivo + verificación (doble-auth) y queda auditado."
        breadcrumbs={[{ label: 'Seguridad' }, { label: 'Cámaras en vivo' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* Contexto del deep-link de pánico: resaltando la cabina, o su grabación si ya no transmite. */}
        {focusTrip && focusInCabins ? (
          <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-brand/25 bg-brand/8 px-4 py-2.5 text-sm text-brand">
            <Radio className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">
              Resaltando la cabina del viaje del pánico{' '}
              <span className="font-mono text-xs">{focusTrip.slice(0, 8)}</span>.
            </span>
            <Link
              href="/security/live-wall"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-brand/10"
            >
              <X className="size-3.5" aria-hidden /> Ver todas
            </Link>
          </div>
        ) : focusGone ? (
          <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm text-warn">
            <Film className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">
              El viaje <span className="font-mono text-xs">{focusTrip.slice(0, 8)}</span> ya no transmite en
              vivo (terminó o dejó de publicar).
            </span>
            <Link
              href={`/media?trip=${focusTrip}`}
              className="inline-flex items-center gap-1 rounded-md bg-warn/15 px-2.5 py-1 text-xs font-semibold hover:bg-warn/25"
            >
              <Film className="size-3.5" aria-hidden /> Ver grabación
            </Link>
          </div>
        ) : null}
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[269/176] rounded-[14px]" />
            ))}
          </div>
        ) : cabins.length === 0 && endedGrantIds.length === 0 ? (
          <EmptyState
            className="flex-1"
            icon={<Video className="size-6" aria-hidden />}
            title="Sin viajes en curso"
            description="No hay viajes activos para monitorear en este momento."
          />
        ) : (
          <div className="stagger grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {/* Visores abiertos cuyo viaje terminó: cierre honesto en vez de que el tile desaparezca sin aviso. */}
            {endedGrantIds.map((tripId) => (
              <div
                key={`ended-${tripId}`}
                className="flex aspect-[269/176] flex-col items-center justify-center gap-2.5 rounded-[14px] border border-border bg-surface-2 p-4 text-center"
              >
                <Radio className="size-5 text-ink-subtle" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-ink">El viaje finalizó</p>
                  <p className="mt-0.5 font-mono text-xs text-ink-muted">{tripId.slice(0, 8)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => closeCamera(tripId)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:border-border-strong"
                >
                  <X className="size-3.5" aria-hidden /> Cerrar
                </button>
              </div>
            ))}
            {cabins.map((cabin) => {
              const grant = grants[cabin.tripId];
              const label = cabin.driverName ?? `Viaje ${cabin.tripId.slice(0, 8)}`;
              const focused = cabin.tripId === focusTrip;
              return (
                <div
                  key={cabin.tripId}
                  ref={focused ? focusRef : undefined}
                  className={cn(
                    'rounded-[16px]',
                    focused && 'ring-2 ring-brand ring-offset-2 ring-offset-bg',
                  )}
                >
                  {grant ? (
                    <LiveCabinViewer
                      grant={grant}
                      label={label}
                      onClose={() => closeCamera(cabin.tripId)}
                    />
                  ) : (
                    <LiveAccessDialog
                      tripId={cabin.tripId}
                      onGranted={(g) => setGrants((prev) => ({ ...prev, [cabin.tripId]: g }))}
                      trigger={<CameraTile cabin={cabin} />}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
