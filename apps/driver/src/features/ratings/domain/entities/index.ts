// Entidades del dominio de calificaciones (lado conductor). El contrato soberano vive en @veo/api-client.
export type { MyRatingView, RatingSubmitRequest, RatingView } from '@veo/api-client';

/**
 * Entrada de "calificar al pasajero" en términos del dominio del conductor: NO expone `ratedRole`
 * (siempre PASSENGER del lado conductor) para que la capa de presentación no pueda equivocarlo. El
 * usecase lo compone en el `RatingSubmitRequest` real. `passengerId` es el `ratedId` del contrato.
 */
export interface RatePassengerInput {
  tripId: string;
  passengerId: string;
  stars: number;
  comment?: string;
}
