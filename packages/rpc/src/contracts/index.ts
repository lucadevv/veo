/**
 * Contratos wire gRPC compartidos — UN tipo por mensaje de los .proto canónicos (packages/rpc/proto).
 * Los consumidores (BFFs, dispatch) importan de acá; PROHIBIDO re-declarar estos shapes a mano.
 */
export type {
  UserReply,
  DriverReply,
  DriverIdsRequest,
  DriversByIdsReply,
  DriverCountsReply,
  UsersByIdsReply,
} from './identity.js';
export type {
  GeoPoint,
  TripReply,
  TripStateReply,
  TripHistoryItem,
  PassengerTripsReply,
  ListDriverTripsRequest,
  DriverTripStatsRequest,
  DriverTripStatsReply,
  PassengerTripStatsRequest,
  PassengerTripStatsReply,
  TripIdsRequest,
  TripModeItem,
  TripModesReply,
} from './trip.js';
export type { MatchReply, SurgeReply, NearbyDriver, NearbyDriversReply } from './dispatch.js';
export type { PaymentReply, UserCreditReply, PendingCashReply } from './payment.js';
export type { PanicReply } from './panic.js';
export type { Segment, SegmentsReply } from './media.js';
export type { RecordReply, VerifyReply } from './audit.js';
export type { AggregateReply } from './rating.js';
export type { TrustedContact, TrustedContactsReply } from './share.js';
export type {
  VehicleReply,
  DriverVehiclesReply,
  VehiclesReply,
  DocumentImageReply,
  FleetDocumentReply,
  DriverDocumentsReply,
  DriverInspectionStatusReply,
  VehicleCountsReply,
  ReviewQueueCountsReply,
  DriverDocsCompleteness,
  DriverDocsCompletenessReply,
  VehicleInspectionStatus,
  VehiclesInspectionStatusReply,
} from './fleet.js';
export type { SavedPlace, PlacesReply, PlaceReply, RemoveReply } from './places.js';
