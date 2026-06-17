import { useEffect, useState } from 'react';

/**
 * Segundos restantes (≥ 0) hasta `targetMs` (epoch en milisegundos). Espejo del `useCountdown` de
 * TripIncoming, pero para `OpenBid.expiresAt`, que ya viene en epoch ms (no ISO). Tick cada segundo.
 */
export function useCountdownMs(targetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetMs) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  if (!targetMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((targetMs - now) / 1000));
}
