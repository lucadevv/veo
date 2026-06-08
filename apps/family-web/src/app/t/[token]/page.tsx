import type { Metadata } from 'next';
import { fetchShareState } from '@/lib/share.server';
import { fetchVideoGrant } from '@/lib/video.server';
import { TrackingView } from '@/components/tracking/tracking-view';
import { StateScreen } from '@/components/tracking/state-screen';
import { RetryButton } from '@/components/tracking/retry-button';

// Datos en vivo: nunca cachear ni prerenderizar estáticamente.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'VEO Family · Viaje en vivo',
  robots: { index: false, follow: false },
};

interface TrackingPageProps {
  params: { token: string };
}

export default async function TrackingPage({ params }: TrackingPageProps) {
  const state = await fetchShareState(params.token);

  switch (state.kind) {
    case 'invalid':
      return <StateScreen variant="invalid" />;
    case 'expired':
      return <StateScreen variant="expired" />;
    case 'revoked':
      return <StateScreen variant="revoked" />;
    case 'unavailable':
      return <StateScreen variant="unavailable" action={<RetryButton />} />;
    case 'ended':
      return (
        <StateScreen
          variant={state.view.status === 'CANCELLED' ? 'ended-cancelled' : 'ended-completed'}
        />
      );
    case 'active': {
      // El bff decide si autoriza la cámara; si no, videoGrant es null y no se muestra video.
      const videoGrant = await fetchVideoGrant(params.token);
      return <TrackingView token={params.token} initialView={state.view} videoGrant={videoGrant} />;
    }
  }
}
