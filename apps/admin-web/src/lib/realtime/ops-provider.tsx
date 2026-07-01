'use client';

import { useEffect } from 'react';
import { useToast } from '@/components/ui/toast';
import { useOpsSocket } from './ops-socket';
import { DRIVER_SWEEP_INTERVAL_MS, useOpsStore } from './ops-store';

/**
 * Conecta el socket /ops UNA vez para todo el dashboard y vuelca los eventos al store.
 * Notifica con toast los pánicos entrantes (el banner global los destaca visualmente).
 */
export function OpsRealtimeProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const setStatus = useOpsStore((s) => s.setStatus);
  const upsertDriver = useOpsStore((s) => s.upsertDriver);
  const pruneStaleDrivers = useOpsStore((s) => s.pruneStaleDrivers);
  const upsertTrip = useOpsStore((s) => s.upsertTrip);
  const addPanic = useOpsStore((s) => s.addPanic);
  const updatePanic = useOpsStore((s) => s.updatePanic);

  const { status } = useOpsSocket({
    onDriverLocation: upsertDriver,
    onTripUpdate: upsertTrip,
    onPanicAlert: (msg) => {
      addPanic(msg);
      toast({
        tone: 'danger',
        title: 'Alerta de pánico',
        description: `Viaje ${msg.tripId.slice(0, 8)} · ${msg.status}`,
      });
    },
    onPanicUpdate: (msg) => updatePanic(msg.panicId, msg.status),
  });

  useEffect(() => {
    setStatus(status);
  }, [status, setStatus]);

  // Sweep periódico: poda los conductores desconectados (sin baja explícita del backend, el marker
  // se saca cuando su última muestra excede la ventana de frescura — misma semántica que el hot-index).
  // La poda es no-op estable cuando nada venció, así el interval no dispara re-renders en vano.
  useEffect(() => {
    const id = setInterval(() => pruneStaleDrivers(), DRIVER_SWEEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pruneStaleDrivers]);

  return <>{children}</>;
}
