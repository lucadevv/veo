'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Carga MapLibre solo en cliente (ssr:false): la librería accede a `window` y WebGL.
 * Reexporta el tipo de marcador para que los consumidores no toquen el módulo pesado.
 */
export const MapView = dynamic(() => import('./map-view').then((m) => m.MapView), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
});

export type { MapMarker, MarkerKind, RadiusCircle } from './map-view';
