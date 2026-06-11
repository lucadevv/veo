import { DomainError } from '@veo/utils';

/**
 * El pasajero debe tener la identidad verificada (KYC) para crear un viaje. Defensa en profundidad:
 * el gate principal vive en el public-bff, pero trip-service —el servicio de REGISTRO del viaje—
 * también lo EXIGE, leyendo el `kycVerified` que el BFF firma en la identidad interna (HMAC). Así un
 * llamador que alcance trip-service sin pasar por el gate del BFF no puede crear viajes sin verificar.
 * Mismo `code` ('KYC_REQUIRED', 403) que el BFF → la app lo refleja igual de punta a punta.
 */
export class KycRequiredError extends DomainError {
  readonly code = 'KYC_REQUIRED';
  readonly httpStatus = 403;
  constructor() {
    super('Verificá tu identidad para pedir tu primer viaje.');
  }
}

/**
 * Un pasajero solo puede tener UN viaje VIVO a la vez ("una sola experiencia de viaje"). Si pide uno
 * nuevo INMEDIATO teniendo otro en curso, se rechaza con 409 y el `activeTripId` en `details`, para que
 * la app lo lleve de vuelta a su viaje activo (re-entrada al flujo unificado) en vez de crear un
 * duplicado. Gate AUTORITATIVO server-side: la UI solo refleja este 409, no decide. No aplica a viajes
 * PROGRAMADOS (reservar a futuro no crea un viaje vivo).
 */
export class ActiveTripExistsError extends DomainError {
  readonly code = 'ACTIVE_TRIP_EXISTS';
  readonly httpStatus = 409;
  constructor(activeTripId: string) {
    super('Ya tenés un viaje en curso. Volvé a él para continuar.', { activeTripId });
  }
}

/**
 * ADR 013 §2 · `dto.category` no existe en el catálogo de ofertas (cliente roto/malicioso). Los ids de
 * oferta SIEMPRE nacen del quote del server: un id fuera del catálogo no puede venir de un cliente
 * honesto → 400 tipado. NUNCA default silencioso a económico (se cobraría un precio que el pasajero
 * no vio en el quote).
 */
export class UnknownOfferingError extends DomainError {
  readonly code = 'UNKNOWN_OFFERING';
  readonly httpStatus = 400;
  constructor(category: string) {
    super('La categoría elegida no existe en el catálogo de ofertas.', { category });
  }
}

/**
 * Lote C1 · Ya existe una propuesta de parada ACTIVA (PROPOSED) para este viaje. Solo puede haber UNA
 * a la vez (índice único parcial en DB). El pasajero debe esperar la respuesta del conductor o el TTL.
 * 409 con el `proposalId` vivo para que la app lo lleve a la propuesta en curso (no crear duplicado).
 */
export class WaypointProposalActiveError extends DomainError {
  readonly code = 'WAYPOINT_PROPOSAL_ACTIVE';
  readonly httpStatus = 409;
  constructor(proposalId: string) {
    super('Ya tenés una parada propuesta esperando respuesta del conductor.', { proposalId });
  }
}

/**
 * Lote C1 · Se alcanzó el máximo de paradas del viaje (MAX_WAYPOINTS). La parada nueva no entra en el
 * cupo. 409: el pasajero no puede agregar más paradas a este viaje.
 */
export class WaypointLimitReachedError extends DomainError {
  readonly code = 'WAYPOINT_LIMIT_REACHED';
  readonly httpStatus = 409;
  constructor(max: number) {
    super('Alcanzaste el máximo de paradas para este viaje.', { max });
  }
}

/**
 * Lote C1 · La propuesta no está en un estado respondible: ya fue resuelta (ACCEPTED/REJECTED/EXPIRED)
 * o venció el TTL. 409: re-responder una propuesta resuelta es un conflicto claro (idempotencia honesta).
 */
export class WaypointProposalNotPendingError extends DomainError {
  readonly code = 'WAYPOINT_PROPOSAL_NOT_PENDING';
  readonly httpStatus = 409;
  constructor(status: string) {
    super('Esta propuesta de parada ya no está pendiente.', { status });
  }
}
