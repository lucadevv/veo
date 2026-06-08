'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FamilyTrackingView } from '@veo/api-client';
import { classifyView, type ShareState } from '@/lib/share-state';
import { fetchShareStateClient } from '@/lib/share-client';
import { useFamilySocket } from '@/hooks/use-family-socket';
import type { FamilyVideoGrant } from '@/lib/video.server';
import { LiveTracking } from './live-tracking';
import { StateScreen } from './state-screen';
import { RetryButton } from './retry-button';

export interface TrackingViewProps {
  token: string;
  initialView: FamilyTrackingView;
  videoGrant: FamilyVideoGrant | null;
}

/**
 * Orquestador cliente: hidrata con la vista del servidor, revalida con React Query
 * y aplica actualizaciones en vivo del Socket.IO sobre la caché. Decide qué pantalla mostrar.
 */
export function TrackingView({ token, initialView, videoGrant }: TrackingViewProps) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['share', token] as const, [token]);

  const { data: state } = useQuery<ShareState>({
    queryKey,
    queryFn: ({ signal }) => fetchShareStateClient(token, signal),
    initialData: () => classifyView(initialView),
    refetchInterval: (query) => (query.state.data?.kind === 'active' ? 30_000 : false),
  });

  // Aplica una mutación a la vista cacheada y la re-clasifica (puede pasar de activo a finalizado).
  const patchView = useCallback(
    (mutate: (view: FamilyTrackingView) => FamilyTrackingView) => {
      queryClient.setQueryData<ShareState>(queryKey, (prev) => {
        if (!prev || (prev.kind !== 'active' && prev.kind !== 'ended')) return prev;
        return classifyView(mutate(prev.view));
      });
    },
    [queryClient, queryKey],
  );

  const { connected } = useFamilySocket(token, {
    onTripUpdate: (msg) =>
      patchView((view) => ({
        ...view,
        status: msg.status,
        etaSeconds: msg.etaSeconds,
        driverLocation: msg.driverLocation ?? view.driverLocation,
      })),
    onDriverLocation: (msg) => patchView((view) => ({ ...view, driverLocation: msg.point })),
    onTripEnded: (msg) =>
      queryClient.setQueryData<ShareState>(queryKey, (prev) =>
        prev && (prev.kind === 'active' || prev.kind === 'ended')
          ? { kind: 'ended', view: { ...prev.view, status: msg.status } }
          : prev,
      ),
    onRevoked: () => queryClient.setQueryData<ShareState>(queryKey, { kind: 'revoked' }),
  });

  switch (state.kind) {
    case 'revoked':
      return <StateScreen variant="revoked" />;
    case 'expired':
      return <StateScreen variant="expired" />;
    case 'invalid':
      return <StateScreen variant="invalid" />;
    case 'unavailable':
      return <StateScreen variant="unavailable" action={<RetryButton />} />;
    case 'ended':
      return (
        <StateScreen
          variant={state.view.status === 'CANCELLED' ? 'ended-cancelled' : 'ended-completed'}
        />
      );
    case 'active':
      return <LiveTracking view={state.view} connected={connected} videoGrant={videoGrant} />;
  }
}
