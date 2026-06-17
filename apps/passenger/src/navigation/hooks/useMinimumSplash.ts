import {useEffect, useRef, useState} from 'react';

/** Piso por defecto (ms) que el splash de marca permanece visible aunque la sesión resuelva al instante. */
export const DEFAULT_MIN_SPLASH_MS = 1900;

/**
 * Gate de DURACIÓN MÍNIMA del splash. Devuelve `true` mientras NO se haya cumplido el piso de tiempo
 * desde el montaje, y `false` una vez transcurrido.
 *
 * Es un PISO, no un techo: solo garantiza que la marca se vea un mínimo razonable cuando la
 * rehidratación (MMKV) es instantánea y el splash flashearía. NO demora cuando la sesión tarda
 * (esa espera la sigue cubriendo el estado `unknown`/`loading` aguas arriba).
 *
 * Hook puro (solo timers): sin reanimated, testeable con fake timers. Respeta reduce-motion vía
 * `ms = 0` (el caller pasa 0 para degradar el piso a instantáneo sin animación de salida).
 */
export function useMinimumSplash(ms: number = DEFAULT_MIN_SPLASH_MS): boolean {
  // `ms <= 0` → sin piso (reduce-motion o desactivado): el gate nace ya cumplido.
  const [pending, setPending] = useState(() => ms > 0);
  // Congela el piso del primer montaje: cambiar `ms` en caliente no reinicia ni alarga el splash.
  const initialMs = useRef(ms);

  useEffect(() => {
    if (initialMs.current <= 0) {
      return;
    }
    const id = setTimeout(() => setPending(false), initialMs.current);
    return () => clearTimeout(id);
  }, []);

  return pending;
}
