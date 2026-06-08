import type {
  ShiftStartResult,
  ShiftState,
  ShiftStatusResult,
  StartShiftInput,
} from '../entities';

/**
 * Contrato del repositorio de turno (capa domain). Implementación concreta en `data/`.
 */
export interface ShiftRepository {
  /** POST /drivers/shift/start — inicia turno (tras gate biométrico). */
  start(input: StartShiftInput): Promise<ShiftStartResult>;
  /** POST /drivers/shift/end — finaliza turno. */
  end(): Promise<ShiftStatusResult>;
  /** POST /drivers/shift/pause — pausa turno. */
  pause(): Promise<ShiftStatusResult>;
  /** GET /drivers/shift/state — estado actual del turno. */
  getState(): Promise<ShiftState>;
}
