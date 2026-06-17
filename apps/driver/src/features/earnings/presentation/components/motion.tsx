import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@veo/ui-kit';

/**
 * Las primitivas Appear/PressableScale ahora son CANÓNICAS del design system (`@veo/ui-kit`) — se
 * re-exportan acá para no tocar los imports de las pantallas. `useCountUp` es específico de ganancias.
 */
export { Appear, PressableScale } from '@veo/ui-kit';

/**
 * Cuenta ascendente sutil de un valor entero (p. ej. céntimos) con ease-out cúbico sobre ~700ms.
 * Respeta reduce-motion: si está activo (o `enabled` es falso) devuelve el valor final al instante.
 * El consumidor formatea el número intermedio (p. ej. con `formatPEN`).
 */
export function useCountUp(target: number, enabled = true): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(() => (reduced || !enabled ? target : 0));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || !enabled || !Number.isFinite(target)) {
      setValue(target);
      return;
    }
    const from = 0;
    const duration = 700;
    const start = Date.now();
    const tick = () => {
      const progress = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [target, enabled, reduced]);

  return value;
}
