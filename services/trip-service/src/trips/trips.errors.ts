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
