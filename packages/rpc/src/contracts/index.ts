/**
 * Contratos wire gRPC compartidos — UN tipo por mensaje de los .proto canónicos (packages/rpc/proto).
 * Los consumidores (BFFs, dispatch) importan de acá; PROHIBIDO re-declarar estos shapes a mano.
 */
export type { UserReply, DriverReply } from './identity.js';
export type {
  GeoPoint,
  TripReply,
  TripStateReply,
  TripHistoryItem,
  PassengerTripsReply,
} from './trip.js';
export type { MatchReply, SurgeReply, NearbyDriver, NearbyDriversReply } from './dispatch.js';
export type { PaymentReply, UserCreditReply } from './payment.js';
export type { PanicReply } from './panic.js';
export type { Segment, SegmentsReply } from './media.js';
export type { RecordReply, VerifyReply } from './audit.js';
export type { AggregateReply } from './rating.js';
export type { TrustedContact, TrustedContactsReply } from './share.js';
export type {
  VehicleReply,
  DriverVehiclesReply,
  FleetDocumentReply,
  DriverDocumentsReply,
} from './fleet.js';
export type { SavedPlace, PlacesReply, PlaceReply, RemoveReply } from './places.js';
