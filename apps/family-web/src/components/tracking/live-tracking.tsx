'use client';

import { Eye } from 'lucide-react';
import type { FamilyTrackingView } from '@veo/api-client';
import { LiveIndicator } from '@/components/ui/live-indicator';
import type { FamilyVideoGrant } from '@/lib/video.server';
import { TripMap } from './trip-map';
import { StatusCard } from './status-card';
import { DriverCard } from './driver-card';
import { HelpButton } from './help-button';
import { CabinVideo } from './cabin-video';

export interface LiveTrackingProps {
  view: FamilyTrackingView;
  connected: boolean;
  videoGrant: FamilyVideoGrant | null;
}

/** Vista activa: mapa grande en vivo + panel con estado, conductor, video y ayuda. */
export function LiveTracking({ view, connected, videoGrant }: LiveTrackingProps) {
  return (
    <main className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <section className="relative h-[52dvh] w-full shrink-0 lg:h-full lg:flex-1">
        <TripMap
          driverLocation={view.driverLocation}
          origin={view.origin}
          destination={view.destination}
          routePolyline={view.routePolyline}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-muted shadow-1">
            <Eye className="size-3.5" aria-hidden />
            Vista familiar
          </span>
          <span className="pointer-events-auto rounded-full bg-surface shadow-1">
            <LiveIndicator connected={connected} />
          </span>
        </div>
      </section>

      <aside className="flex w-full flex-1 flex-col gap-3 overflow-y-auto p-4 lg:max-w-md lg:flex-none">
        <StatusCard view={view} />
        {view.driver ? <DriverCard driver={view.driver} /> : null}
        {videoGrant ? <CabinVideo grant={videoGrant} /> : null}
        <HelpButton className="w-full" />
        <p className="px-1 pt-1 text-xs leading-relaxed text-ink-subtle">
          Tu acceso es solo de lectura. El link caduca cuando el viaje termina.
        </p>
      </aside>
    </main>
  );
}
