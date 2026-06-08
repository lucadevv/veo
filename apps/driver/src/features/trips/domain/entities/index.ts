import type {
  AcceptTripRequest,
  ArrivingTripRequest,
  DriverCancelTripRequest,
  DriverOfferView,
  DriverTripStateView,
  DriverTripView,
  RouteStep,
  StartTripRequest,
  TripRoute,
} from '@veo/api-client';

/**
 * Entidades del dominio de viajes (lado conductor). Antes de aceptar, el conductor solo ve
 * distancia + tarifa estimada (regla #5 de CLAUDE.md); los datos completos llegan post-aceptación.
 */
export type TripOffer = DriverOfferView;
export type Trip = DriverTripView;
export type TripState = DriverTripStateView;
export type AcceptTripInput = AcceptTripRequest;
export type ArrivingTripInput = ArrivingTripRequest;
export type StartTripInput = StartTripRequest;
export type CancelTripInput = DriverCancelTripRequest;

/** Ruta del viaje activo con geometría completa + pasos de navegación turn-by-turn. */
export type TripRouteView = TripRoute;
/** Una maniobra de la ruta (instrucción + distancia + tipo de giro + geometría del tramo). */
export type TripRouteStep = RouteStep;
