/** Resolución de rutas a los .proto versionados dentro de @veo/rpc (dev y Docker). */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** packages/rpc/proto */
export const PROTO_DIR = join(here, '..', 'proto');

export const SERVICE_PROTO = {
  identity: 'identity.proto',
  trip: 'trip.proto',
  dispatch: 'dispatch.proto',
  payment: 'payment.proto',
  panic: 'panic.proto',
  media: 'media.proto',
  audit: 'audit.proto',
  rating: 'rating.proto',
  share: 'share.proto',
  fleet: 'fleet.proto',
  places: 'places.proto',
} as const;

export type ServiceName = keyof typeof SERVICE_PROTO;

export const SERVICE_PACKAGE: Record<ServiceName, string> = {
  identity: 'veo.identity.v1',
  trip: 'veo.trip.v1',
  dispatch: 'veo.dispatch.v1',
  payment: 'veo.payment.v1',
  panic: 'veo.panic.v1',
  media: 'veo.media.v1',
  audit: 'veo.audit.v1',
  rating: 'veo.rating.v1',
  share: 'veo.share.v1',
  fleet: 'veo.fleet.v1',
  places: 'veo.places.v1',
};

/** Nombre del service gRPC dentro de cada package. */
export const SERVICE_RPC_NAME: Record<ServiceName, string> = {
  identity: 'IdentityService',
  trip: 'TripService',
  dispatch: 'DispatchService',
  payment: 'PaymentService',
  panic: 'PanicService',
  media: 'MediaService',
  audit: 'AuditService',
  rating: 'RatingService',
  share: 'ShareService',
  fleet: 'FleetService',
  places: 'PlacesService',
};

export function protoPathFor(service: ServiceName): string {
  return join(PROTO_DIR, SERVICE_PROTO[service]);
}
