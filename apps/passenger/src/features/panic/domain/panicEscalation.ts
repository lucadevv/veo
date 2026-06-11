/**
 * Puerto de ESCALAMIENTO del pánico silencioso (DIP).
 *
 * El disparo oculto (3× volumen) es DISCRETO por diseño: no muestra nada al detectarse. Pero si
 * tras agotar los reintentos del `SilentPanicDispatcher` el server nunca confirmó la alerta,
 * seguir en silencio sería un ÉXITO FALSO: el pasajero cree que pidió ayuda y nadie lo sabe.
 * Este puerto saca el pánico a un canal VISIBLE (degradación honesta) para que el pasajero pueda
 * reintentar por el camino manual, que ya muestra error y botón de reenvío.
 */
export interface PanicEscalation {
  /** Hace visible el pánico fallido para el viaje dado (p. ej. abre la pantalla manual). */
  escalate(tripId: string): void;
}
