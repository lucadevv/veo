/**
 * Enlaces de seguimiento (BR-S05) y vista pública familiar.
 * - Crear/revocar: comandos REST internos firmados (auth). La revocación además corta las sesiones
 *   Socket.IO vivas del enlace (link:revoked).
 * - Vista pública: agrega share + estado de viaje + conductor/vehículo + ubicación + ETA/ruta (maps).
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DownstreamError, GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import type { MapsClient } from '@veo/maps';
import type { FamilyTrackingView, FamilyVideoGrant, GeoPoint } from '@veo/api-client';
import {
  GRPC_FLEET,
  GRPC_IDENTITY,
  GRPC_RATING,
  LIVEKIT,
  MAPS,
  REST_SHARE,
  REST_TRIP,
} from '../infra/downstream.tokens';
import { familyRoom } from './share.types';
import { type LiveKitConfig, liveKitEnabled, mintViewerToken } from './livekit-token';
import { ANONYMOUS_IDENTITY, internalGrpcMetadata } from '../infra/internal-identity';
import type { AggregateReply, DriverReply, VehicleReply } from '../infra/grpc-types';
import { RealtimeStateService } from '../realtime/realtime-state.service';
import { FamilyGateway } from '../realtime/family.gateway';
import { type TripResource } from '../trips/dto/trip.dto';
import { type CreateShareLinkDto } from './dto/share.dto';
import { type CreatedShareLink, type ShareTrackingDownstream } from './share.types';
import { shareTokenExpiryIso } from './share-token';
import {
  assembleFamilyView,
  assembleMaskedPanicView,
  buildFamilyDriver,
  isPanicActive,
  safeTripStatus,
} from './family-view';

@Injectable()
export class ShareService {
  constructor(
    @Inject(REST_SHARE) private readonly shareRest: InternalRestClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_RATING) private readonly ratingGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
    @Inject(MAPS) private readonly maps: MapsClient,
    @Inject(LIVEKIT) private readonly livekit: LiveKitConfig,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    private readonly state: RealtimeStateService,
    private readonly gateway: FamilyGateway,
  ) {}

  createLink(
    user: AuthenticatedUser,
    tripId: string,
    dto: CreateShareLinkDto,
  ): Promise<CreatedShareLink> {
    return this.shareRest.post<CreatedShareLink>(`/share/${tripId}`, { identity: user, body: dto });
  }

  async revoke(user: AuthenticatedUser, shareId: string): Promise<{ revokedAt: string }> {
    const result = await this.shareRest.post<{ revokedAt: string }>(`/share/${shareId}/revoke`, {
      identity: user,
    });
    // Corta en vivo cualquier sesión de seguimiento abierta con este enlace.
    this.gateway.revokeByShareId(shareId);
    return result;
  }

  /** Vista pública de seguimiento (sin login): construye familyTrackingView de @veo/api-client. */
  async publicView(token: string): Promise<FamilyTrackingView> {
    let downstream: ShareTrackingDownstream;
    try {
      downstream = await this.shareRest.get<ShareTrackingDownstream>(
        `/public/share/${encodeURIComponent(token)}`,
        { identity: ANONYMOUS_IDENTITY },
      );
    } catch (err) {
      // Revocado/expirado/no encontrado: la página familiar muestra el estado "revoked".
      if (err instanceof DownstreamError && [403, 404, 410].includes(err.status)) {
        return this.revokedView(token);
      }
      throw err;
    }

    // SEGURIDAD-CRÍTICA · pánico oculto (VEO_SPEC_FAMILIA, fail-safe = ocultar).
    // share-service marca el viaje como 'PANIC' en su read-model al consumir panic.triggered; ese
    // crudo llega en downstream.status. Si hay (o podría haber) pánico, NO consultamos trip-service,
    // ubicación en vivo ni maps: devolvemos un estado benigno (viaje TERMINADO) sin filtrar nada.
    if (isPanicActive(downstream.status)) {
      return assembleMaskedPanicView(downstream.tripId, shareTokenExpiryIso(token));
    }

    const meta = internalGrpcMetadata(ANONYMOUS_IDENTITY, this.secret);
    const trip = await this.tripRest
      .get<TripResource>(`/trips/${downstream.tripId}`, { identity: ANONYMOUS_IDENTITY })
      .catch(() => null);

    // Defensa en profundidad: si por cualquier vía trip-service expusiera un estado de pánico,
    // también enmascaramos (cubre desfases del read-model vs. el estado autoritativo del viaje).
    if (isPanicActive(trip?.status)) {
      return assembleMaskedPanicView(downstream.tripId, shareTokenExpiryIso(token));
    }

    const { driver, aggregate, vehicle } = await this.loadDriver(downstream.driverId, trip?.vehicleId ?? null, meta);

    const live = this.state.getLocation(downstream.tripId);
    const driverLocation: GeoPoint | null =
      live?.point ??
      (downstream.approximateLocation
        ? { lat: downstream.approximateLocation.lat, lon: downstream.approximateLocation.lon }
        : null);
    const destination: GeoPoint | null = trip?.destination ?? null;
    const origin: GeoPoint | null = trip?.origin ?? null;

    let etaSeconds: number | null = null;
    let routePolyline: string | null = trip?.routePolyline ?? null;
    if (driverLocation && destination) {
      const route = await this.maps.route(driverLocation, destination);
      etaSeconds = route.durationSeconds;
      if (route.polyline) routePolyline = route.polyline;
    }

    return assembleFamilyView({
      tripId: downstream.tripId,
      status: safeTripStatus(trip?.status, downstream.status),
      origin,
      destination,
      driverLocation,
      driver: buildFamilyDriver(driver, aggregate, vehicle),
      etaSeconds,
      routePolyline,
      expiresAt: shareTokenExpiryIso(token),
      revoked: false,
    });
  }

  /**
   * Autoriza el video del habitáculo para un enlace de seguimiento.
   * - Si LiveKit no está configurado → 404 (la web familiar degrada a "sin video").
   * - Valida el token contra share-service (revocado/expirado → 403).
   * - Solo durante el viaje EN CURSO (el pasajero está físicamente en el habitáculo).
   * Devuelve un token de viewer (solo suscripción) firmado para la sala del viaje.
   */
  async videoGrant(token: string): Promise<FamilyVideoGrant> {
    if (!liveKitEnabled(this.livekit)) {
      throw new NotFoundException('El video del habitáculo no está disponible');
    }

    let downstream: ShareTrackingDownstream;
    try {
      downstream = await this.shareRest.get<ShareTrackingDownstream>(
        `/public/share/${encodeURIComponent(token)}`,
        { identity: ANONYMOUS_IDENTITY },
      );
    } catch (err) {
      if (err instanceof DownstreamError && [403, 404, 410].includes(err.status)) {
        throw new ForbiddenException('Enlace de seguimiento no válido para video');
      }
      throw err;
    }

    // SEGURIDAD-CRÍTICA · pánico oculto (VEO_SPEC_FAMILIA, fail-safe = ocultar).
    // Durante un pánico el read-model marca 'PANIC' aunque trip-service siga en IN_PROGRESS; NUNCA
    // emitir el grant de video del habitáculo: delataría que algo pasa y expondría video en vivo.
    if (isPanicActive(downstream.status)) {
      throw new ForbiddenException('La cámara no está disponible para este viaje');
    }

    const trip = await this.tripRest
      .get<TripResource>(`/trips/${downstream.tripId}`, { identity: ANONYMOUS_IDENTITY })
      .catch(() => null);
    if (isPanicActive(trip?.status)) {
      throw new ForbiddenException('La cámara no está disponible para este viaje');
    }
    const status = safeTripStatus(trip?.status, downstream.status);
    if (status !== 'IN_PROGRESS') {
      throw new ForbiddenException('La cámara solo está disponible durante el viaje en curso');
    }

    const room = familyRoom(downstream.tripId);
    const minted = mintViewerToken(this.livekit, {
      room,
      identityPrefix: `family-${downstream.shareId}`,
    });
    return { url: this.livekit.url, token: minted.token, roomName: room };
  }

  /** Vista mínima para enlaces revocados/expirados (la firma del token aún lleva la expiración). */
  private revokedView(token: string): FamilyTrackingView {
    return assembleFamilyView({
      tripId: '',
      status: safeTripStatus(),
      origin: null,
      destination: null,
      driverLocation: null,
      driver: null,
      etaSeconds: null,
      routePolyline: null,
      expiresAt: shareTokenExpiryIso(token),
      revoked: true,
    });
  }

  /** Carga conductor (identity), agregado de rating y vehículo (fleet) en paralelo. */
  private async loadDriver(
    driverId: string | null,
    vehicleId: string | null,
    meta: Record<string, string>,
  ): Promise<{ driver: DriverReply | null; aggregate: AggregateReply | null; vehicle: VehicleReply | null }> {
    if (!driverId) return { driver: null, aggregate: null, vehicle: null };
    const [driver, aggregate, vehicle] = await Promise.all([
      this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta).catch(() => null),
      this.ratingGrpc
        .call<AggregateReply>('GetAggregate', { subjectId: driverId }, meta)
        .catch(() => null),
      vehicleId
        ? this.fleetGrpc.call<VehicleReply>('GetVehicle', { id: vehicleId }, meta).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      driver: driver?.found ? driver : null,
      aggregate: aggregate?.found ? aggregate : null,
      vehicle: vehicle?.found ? vehicle : null,
    };
  }
}
