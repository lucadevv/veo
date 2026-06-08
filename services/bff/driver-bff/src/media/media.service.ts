/**
 * Media del conductor (BR-S01). Proxea al media-service la emisión del token LiveKit de
 * publicación de la cámara del habitáculo. El media-service emite un token con canPublish:true,
 * por lo que el conductor puede transmitir su cámara durante todo el viaje.
 *
 * Anti-IDOR (Lote 2.11 · V1): el media-service SOLO valida el HMAC interno BFF→servicio
 * (InternalIdentityGuard), NO la pertenencia del viaje. Sin esta verificación en el BFF, cualquier
 * conductor autenticado podía pedir el token de publicación de la cabina de un viaje AJENO (fuga de
 * video sensible, Ley 29733). Replicamos el gate del lado pasajero (public-bff `videoGrant`): el
 * viaje debe estar asignado a ESTE conductor y estar IN_PROGRESS. El driverId del viaje es el id de
 * PERFIL de conductor, no el userId del JWT, así que se deriva vía GetDriverByUser (mismo patrón que
 * chat/dispatch en este BFF).
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply, TripReply } from '../common/grpc-replies';
import type { PublisherGrant } from './dto/media.dto';

/** Forma de la respuesta del media-service `POST /media/rooms/:tripId/token`. */
interface MediaRoomToken {
  roomName: string;
  token: string;
  url: string;
  expiresInSeconds: number;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  /** Emite un token de publicación para la room del viaje y lo mapea al contrato del cliente. */
  async issuePublisherToken(
    identity: AuthenticatedUser,
    tripId: string,
    name?: string,
  ): Promise<PublisherGrant> {
    // Anti-IDOR: el viaje debe pertenecer a ESTE conductor y estar en curso. Se verifica ANTES de
    // proxear al media-service, que NO valida la pertenencia (solo el HMAC interno).
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new ForbiddenException('No existe un perfil de conductor para este usuario');
    }

    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id: tripId }, identity);
    if (!trip.found) throw new NotFoundException('Viaje no encontrado');
    if (trip.driverId !== driver.id) {
      throw new ForbiddenException('El viaje no pertenece al conductor');
    }
    if (trip.status !== 'IN_PROGRESS') {
      throw new ForbiddenException('La cámara solo está disponible durante el viaje en curso');
    }

    const reply = await this.rest.client('media').post<MediaRoomToken>(
      `/media/rooms/${tripId}/token`,
      // El nombre visible del conductor; si no llega, el media-service usa la identidad (userId).
      { identity, body: { name: name ?? identity.userId } },
    );
    return { url: reply.url, token: reply.token, room: reply.roomName };
  }
}
