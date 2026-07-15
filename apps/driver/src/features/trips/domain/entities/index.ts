import type {
  AcceptTripRequest,
  ArrivingTripRequest,
  CompleteTripRequest,
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
export type CompleteTripInput = CompleteTripRequest;
export type CancelTripInput = DriverCancelTripRequest;

/** Ruta del viaje activo con geometría completa + pasos de navegación turn-by-turn. */
export type TripRouteView = TripRoute;
/** Una maniobra de la ruta (instrucción + distancia + tipo de giro + geometría del tramo). */
export type TripRouteStep = RouteStep;

/**
 * Tasa de comisión ON-DEMAND VIGENTE (panel admin vía driver-bff). En bps Int (2000 = 20 %) + version
 * del CAS del panel. La app la pliega a fracción con `commissionRateFromBps` para el desglose de ganancia.
 */
export interface CommissionRateView {
  onDemandRateBps: number;
  version: number;
}

/**
 * EFECTIVO · cobro en efectivo que el conductor dejó SIN confirmar tras completar un viaje (force-close antes
 * de tocar "Sí, recibí"). Alimenta el banner del dashboard que PERSIGUE la confirmación al reabrir la app.
 * `tripId` para resolver el paymentId server-side al confirmar; `amountCents` (bruto del viaje) para el copy.
 */
export interface PendingCash {
  tripId: string;
  amountCents: number;
}
