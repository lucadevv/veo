import type {
  PanicTriggerRequest,
  PanicTriggerResult,
  PanicView,
} from '@veo/api-client';

/**
 * Abstracción del repositorio de Pánico (DIP).
 *
 * NOTA (regla del repo): la DETECCIÓN del pánico vive en un módulo nativo (background,
 * secuencia oculta 3× volumen), NO en JS. Este repositorio sólo cubre el fan-out REST
 * de respaldo y la consulta de estado; el disparo principal lo hace el native module.
 */
export interface PanicRepository {
  /** POST /panic → dispara/registra la alerta (idempotente vía dedupKey). */
  trigger(input: PanicTriggerRequest): Promise<PanicTriggerResult>;
  /** GET /panic/:id → estado de la alerta. */
  getPanic(panicId: string): Promise<PanicView>;
}
