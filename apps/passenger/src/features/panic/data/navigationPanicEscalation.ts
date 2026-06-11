import { navigationRef } from '../../../navigation/navigationRef';
import type { PanicEscalation } from '../domain/panicEscalation';

/**
 * Implementación de `PanicEscalation` sobre el `navigationRef` global (mismo patrón que el
 * deep-link de push en `services/messaging.ts`: navegar DESDE FUERA del árbol de React).
 *
 * Abre la pantalla manual de pánico (`Panic`), que ya sabe mostrar el error y reintentar con un
 * tap: es el canal visible que el feature YA soporta (no hay notificaciones locales en la app).
 * Romper la discreción acá es deliberado: tras ~2 min sin confirmación del server, el riesgo de
 * que la alerta se pierda en silencio pesa más que mantener la UI oculta.
 */
export class NavigationPanicEscalation implements PanicEscalation {
  escalate(tripId: string): void {
    if (!navigationRef.isReady()) {
      // Sin contenedor montado no hay UI a la cual escalar; queda el registro explícito del fallo.
      console.error('[panic] escalamiento sin navegación lista; alerta NO confirmada', { tripId });
      return;
    }
    // `escalated: true` para que la pantalla NO aterrice en su estado neutro "¿Necesitas ayuda?":
    // debe decir la verdad (la alerta silenciosa falló) y ofrecer el reintento manual de entrada.
    navigationRef.navigate('Panic', { tripId, escalated: true });
  }
}
