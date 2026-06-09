'use client';

import { useState } from 'react';
import { Lock, Video } from 'lucide-react';
import { useTrips } from '@/lib/api/queries';
import type { LiveViewerToken } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { dateTime } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LiveAccessDialog } from '@/components/live/live-access-dialog';
import { LiveCabinViewer } from '@/components/live/live-cabin-viewer';

/**
 * Muro de cámaras EN VIVO: cabinas de los viajes en curso. Abrir una exige doble-auth (motivo + step-up MFA)
 * y queda auditado server-side. Gate de presentación `live:view`; el media-bff + media-service re-autorizan
 * (rol + MFA fresca). Multiview: varias cámaras abiertas a la vez, cada una con su token solo-suscripción.
 */
export default function LiveWallPage() {
  const user = useSession();
  const query = useTrips({ status: 'IN_PROGRESS' });
  // tripId → grant activo. Abrir una cámara es por-viaje (cada una con su doble-auth); cerrar la quita.
  const [grants, setGrants] = useState<Record<string, LiveViewerToken>>({});

  if (!can(user, 'live:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Cámaras en vivo" breadcrumbs={[{ label: 'Seguridad' }, { label: 'Cámaras en vivo' }]} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol de Cumplimiento o Administrador para el muro de cámaras en vivo."
        />
      </div>
    );
  }

  const trips = query.data?.pages.flatMap((p) => p.items) ?? [];

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
        ) : trips.length === 0 && !query.isLoading ? (
          <EmptyState
            className="flex-1"
            icon={<Video className="size-6" aria-hidden />}
            title="Sin viajes en curso"
            description="No hay viajes activos para monitorear en este momento."
          />
        ) : (
          <div className="grid gap-4 pt-4 sm:grid-cols-2 xl:grid-cols-3">
            {trips.map((trip) => {
              const grant = grants[trip.id];
              const label = `Viaje ${trip.id.slice(0, 8)}`;
              if (grant) {
                return (
                  <LiveCabinViewer
                    key={trip.id}
                    grant={grant}
                    label={label}
                    onClose={() => closeCamera(trip.id)}
                  />
                );
              }
              return (
                <Card key={trip.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-ink">{trip.id.slice(0, 8)}</span>
                    <span className="text-xs text-ink-muted">{dateTime(trip.createdAt)}</span>
                  </div>
                  <p className="text-xs text-ink-muted">
                    Pasajero {trip.passengerId.slice(0, 8)} · Conductor{' '}
                    {trip.driverId ? trip.driverId.slice(0, 8) : '—'}
                  </p>
                  <LiveAccessDialog
                    tripId={trip.id}
                    onGranted={(g) => setGrants((prev) => ({ ...prev, [trip.id]: g }))}
                    trigger={
                      <Button size="sm" variant="primary">
                        <Video className="size-4" aria-hidden />
                        Ver cabina
                      </Button>
                    }
                  />
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
