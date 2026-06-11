/**
 * Re-export de los contratos wire gRPC de @veo/rpc (fuente ÚNICA, derivada de los .proto canónicos).
 * Este módulo NO declara shapes propios: existía como copia a mano y drifteó (DriverReply sin
 * suspendedAt, VehicleReply sin vehicleType/status). Los alias `*Reply` conservan los nombres
 * históricos de este BFF; el shape canónico vive en packages/rpc/src/contracts.
 */
export type {
  UserReply,
  DriverReply,
  TripReply,
  TripStateReply,
  PassengerTripsReply,
  SurgeReply,
  NearbyDriversReply,
  PaymentReply,
  PanicReply,
  AggregateReply,
  TrustedContactsReply,
  VehicleReply,
  DriverVehiclesReply,
  PlacesReply,
  PlaceReply,
} from '@veo/rpc';
export type {
  TripHistoryItem as TripHistoryItemReply,
  NearbyDriver as NearbyDriverReply,
  TrustedContact as TrustedContactReply,
  SavedPlace as SavedPlaceReply,
  RemoveReply as RemovePlaceReply,
} from '@veo/rpc';
