import { useEffect, useRef } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';

/**
 * Arma el detector NATIVO de pánico (triple pulsación de volumen) mientras un viaje está activo y, al
 * detectarse la secuencia oculta, dispara el flujo de pánico REAL de forma SILENCIOSA (sin UI).
 *
 * Diseño (BR de seguridad):
 *  - DISCRETO: no muestra nada en pantalla al detectar; ante coacción, no debe alertar al agresor.
 *  - El disparo se ENCOLA en el `SilentPanicDispatcher` (singleton de DI): entrega at-least-once
 *    con reintentos (backoff + dedupKey idempotente) que SOBREVIVEN al desmontaje de esta pantalla
 *    — el retry no puede morir con el componente justo en la ruta de seguridad.
 *  - Si tras agotar reintentos el server nunca confirmó, el dispatcher ESCALA al canal visible
 *    (pantalla manual de pánico): degradación honesta, nunca una alerta perdida en silencio.
 *
 * @param tripId  Viaje activo sobre el que se dispara la alerta.
 * @param enabled Solo arma el detector cuando el viaje está en curso (no completado/cancelado).
 */
export function usePanicAutoTrigger(tripId: string, enabled: boolean): void {
  const panicTrigger = useDependency(TOKENS.panicTrigger);
  const silentPanicDispatcher = useDependency(TOKENS.silentPanicDispatcher);

  // Refs para usar valores frescos dentro del callback nativo sin re-armar el detector.
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    panicTrigger.start(() => {
      // Encolado síncrono y sin throw: nunca relanza para no afectar el proceso nativo.
      silentPanicDispatcher.dispatch(tripIdRef.current);
    });

    return () => {
      panicTrigger.stop();
    };
  }, [enabled, panicTrigger, silentPanicDispatcher]);
}
