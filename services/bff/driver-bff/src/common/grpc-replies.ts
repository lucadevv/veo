/**
 * Re-export de los contratos wire gRPC de @veo/rpc (fuente ÚNICA, derivada de los .proto canónicos).
 * Este módulo NO declara shapes propios: existía como copia a mano y drifteó (DriverReply sin
 * name/suspendedAt, TripReply sin el enriquecimiento del detalle). Importá de acá o de '@veo/rpc'.
 */
export type {
  UserReply,
  DriverReply,
  TripReply,
  TripStateReply,
  MatchReply,
  SurgeReply,
  PaymentReply,
  AggregateReply,
  VehicleReply,
  DriverVehiclesReply,
  FleetDocumentReply,
  DriverDocumentsReply,
} from '@veo/rpc';
