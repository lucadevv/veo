import { useEffect, useState } from 'react';

/**
 * ADR-021 Fase J (J2) · Hook CANÓNICO de cuenta atrás del conductor — ÚNICO en toda la app (antes había
 * dos: `useCountdownMs` en bidding para epoch ms + un `useCountdown` local para ISO string en la extinta
 * TripIncomingScreen → "cerebro dividido", dos encodings, dos implementaciones espejo). Ahora TODOS los countdowns del
 * conductor (oferta FIXED "Viaje entrante", puja abierta, sheet de contraoferta) pasan por acá.
 *
 * Contrato ÚNICO: `targetMs` en epoch ms. El caller que tenga un ISO string (p.ej. el push FIXED) lo
 * convierte con `toEpochMs()` en el borde — así el hook nunca adivina el encoding. `0`/undefined → 0
 * (indeterminado, sin tickear). Devuelve los segundos restantes (≥ 0, redondeo hacia arriba), tick 1s.
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

/**
 * Normaliza al encoding único del hook: un `expiresAt` que viene como ISO string (p.ej. el push de la
 * oferta FIXED, `dispatch:offer`) → epoch ms; `undefined`/vacío → 0 (indeterminado). Los orígenes que ya
 * son epoch ms (OpenBid del board) NO necesitan esto.
 */
export function toEpochMs(expiresAt: string | undefined): number {
  return expiresAt ? new Date(expiresAt).getTime() : 0;
}
