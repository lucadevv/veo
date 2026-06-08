import type {
  DriverShiftStartResult,
  DriverShiftStateView,
  DriverShiftStatusResult,
  DriverStartShiftRequest,
} from '@veo/api-client';

/**
 * Entidades del dominio de turno (shift). El inicio de turno exige verificación biométrica
 * obligatoria (regla #1 de CLAUDE.md): `sessionRef` referencia la sesión biométrica ONNX.
 */
export type StartShiftInput = DriverStartShiftRequest;
export type ShiftStartResult = DriverShiftStartResult;
export type ShiftStatusResult = DriverShiftStatusResult;
export type ShiftState = DriverShiftStateView;
