'use client';

import { useState } from 'react';
import { Lock, Video } from 'lucide-react';
import { useLiveCabins } from '@/lib/api/queries';
import type { LiveViewerToken } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
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

  const cabins = query.data ?? [];

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
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[269/176] rounded-[14px]" />
            ))}
          </div>
        ) : cabins.length === 0 ? (
          <EmptyState
            className="flex-1"
            icon={<Video className="size-6" aria-hidden />}
            title="Sin viajes en curso"
            description="No hay viajes activos para monitorear en este momento."
          />
        ) : (
          <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cabins.map((cabin) => {
              const grant = grants[cabin.tripId];
              const label = cabin.driverName ?? `Viaje ${cabin.tripId.slice(0, 8)}`;
              if (grant) {
                return (
                  <LiveCabinViewer
                    key={cabin.tripId}
                    grant={grant}
                    label={label}
                    onClose={() => closeCamera(cabin.tripId)}
                  />
                );
              }
              return (
                <LiveAccessDialog
                  key={cabin.tripId}
                  tripId={cabin.tripId}
                  onGranted={(g) => setGrants((prev) => ({ ...prev, [cabin.tripId]: g }))}
                  trigger={<CameraTile cabin={cabin} />}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
