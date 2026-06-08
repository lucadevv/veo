/**
 * Puerto de DETECCIÓN del pánico (DIP). La regla del repo exige que la detección viva en un módulo
 * nativo (secuencia oculta 3× volumen, funciona en background, latencia de fan-out < 3s). Aquí solo
 * se define la abstracción; la OLEADA NATIVA la implementa y la cablea al `TriggerPanicUseCase`.
 *
 * Firma exacta para la oleada nativa:
 *   start(onTriggered: () => void): void   // arranca la detección; invoca el callback al disparar
 *   stop(): void                           // detiene la detección
 */
export interface PanicTrigger {
  start(onTriggered: () => void): void;
  stop(): void;
}
