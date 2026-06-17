import type { ShiftRepository } from '../repositories/shift-repository';
import type { ShiftStartResult, ShiftState, ShiftStatusResult } from '../entities';

/** Coordenadas opcionales del dispositivo al iniciar turno (las provee la oleada nativa de GPS). */
export interface ShiftStartGeo {
  geoLat?: number;
  geoLon?: number;
}

/**
 * Caso de uso: iniciar/reanudar turno tras el gate biométrico.
 * Recibe el `sessionRef` ya emitido por el puerto de captura nativa.
 */
export class StartShiftUseCase {
  constructor(private readonly shift: ShiftRepository) {}

  execute(sessionRef: string, geo: ShiftStartGeo = {}): Promise<ShiftStartResult> {
    return this.shift.start({ sessionRef, geoLat: geo.geoLat, geoLon: geo.geoLon });
  }
}

/** Caso de uso: finalizar turno (→ OFFLINE). */
export class EndShiftUseCase {
  constructor(private readonly shift: ShiftRepository) {}

  execute(): Promise<ShiftStatusResult> {
    return this.shift.end();
  }
}

/** Caso de uso: pausar turno (→ ON_BREAK). */
export class PauseShiftUseCase {
  constructor(private readonly shift: ShiftRepository) {}

  execute(): Promise<ShiftStatusResult> {
    return this.shift.pause();
  }
}

/** Caso de uso: leer el estado actual del turno. */
export class GetShiftStateUseCase {
  constructor(private readonly shift: ShiftRepository) {}

  execute(): Promise<ShiftState> {
    return this.shift.getState();
  }
}
