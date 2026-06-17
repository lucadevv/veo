import type {PanicTrigger} from '../domain/panicTrigger';

/**
 * Detección de pánico por defecto (no-op) mientras no exista el módulo nativo. No detecta nada:
 * el acceso al pánico queda disponible de forma MANUAL desde la pantalla. La OLEADA NATIVA
 * reemplaza este binding por la detección real (triple volumen, background).
 */
export class NoopPanicTrigger implements PanicTrigger {
  start(_onTriggered: () => void): void {
    // Sin módulo nativo no hay detección automática.
  }

  stop(): void {
    // No-op.
  }
}
