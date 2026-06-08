import { useEffect, useRef } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';

/**
 * Arma el detector NATIVO de pánico (triple pulsación de volumen) mientras un viaje está activo y, al
 * detectarse la secuencia oculta, dispara el flujo de pánico REAL de forma SILENCIOSA (sin UI).
 *
 * Diseño (BR de seguridad):
 *  - DISCRETO: no muestra nada en pantalla al detectar; ante coacción, no debe alertar al agresor.
 *  - El disparo ejecuta `TriggerPanicUseCase` (ubicación + firma HMAC + `POST /panic`) directamente,
 *    igual que la pantalla manual, pero sin requerir interacción.
 *  - Si el envío falla (p. ej. falta la clave HMAC del backend), se registra sin romper la app; el
 *    acceso MANUAL al pánico sigue disponible.
 *
 * @param tripId  Viaje activo sobre el que se dispara la alerta.
 * @param enabled Solo arma el detector cuando el viaje está en curso (no completado/cancelado).
 */
export function usePanicAutoTrigger(tripId: string, enabled: boolean): void {
  const panicTrigger = useDependency(TOKENS.panicTrigger);
  const triggerPanic = useDependency(TOKENS.triggerPanicUseCase);

  // Refs para usar valores frescos dentro del callback nativo sin re-armar el detector.
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    panicTrigger.start(() => {
      // Disparo silencioso: nunca relanza para no afectar el proceso nativo.
      void triggerPanic.execute(tripIdRef.current).catch((error) => {
        console.warn('[panic] disparo automático falló:', error);
      });
    });

    return () => {
      panicTrigger.stop();
    };
  }, [enabled, panicTrigger, triggerPanic]);
}
