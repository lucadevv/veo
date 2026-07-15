/**
 * Lugares guardados del pasajero (Casa/Trabajo/favoritos). REST → gRPC sobre places-service.
 *
 * Anti-IDOR: el userId NUNCA viaja en el cuerpo. El BFF valida el JWT, firma la identidad interna
 * (HMAC) con el userId autenticado y la propaga en la metadata gRPC de CADA llamada. El servicio la
 * verifica y resuelve el userId del contexto autenticado, por lo que un usuario solo opera sobre sus
 * propios lugares.
 *
 * Mapeo de errores gRPC → DomainError (el filtro global los lleva a HTTP):
 *  - INVALID_ARGUMENT (3)   → 400 VALIDATION    (validación de dominio)
 *  - NOT_FOUND (5)          → 404 NOT_FOUND     (lugar inexistente o de otro usuario)
 *  - RESOURCE_EXHAUSTED (8) → 409 CONFLICT      (tope de favoritos alcanzado)
 *  - UNAUTHENTICATED (16)   → 401 UNAUTHORIZED  (identidad interna inválida — no debería pasar con JWT válido)
 */
import { Inject, Injectable } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '@veo/utils';
import { GrpcServiceClient } from '@veo/rpc';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { GRPC_PLACES } from '../infra/downstream.tokens';
import type {
  PlaceReply,
  PlacesReply,
  RemovePlaceReply,
  SavedPlaceReply,
} from '../infra/grpc-types';
import {
  PLACE_KINDS,
  type PlaceKind,
  type PlaceView,
  type SavePlaceDto,
  type UpdatePlaceDto,
} from './dto/places.dto';

@Injectable()
export class PlacesService {
  constructor(
    @Inject(GRPC_PLACES) private readonly placesGrpc: GrpcServiceClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
  ) {}

  /** Lista los lugares guardados del usuario autenticado (ordenados server-side). */
  async list(user: AuthenticatedUser): Promise<PlaceView[]> {
    const reply = await this.call<PlacesReply>('ListByUser', {}, user);
    return reply.places.map(toView);
  }

  /** Crea (o upsert para HOME/WORK) un lugar del usuario autenticado. */
  async save(user: AuthenticatedUser, dto: SavePlaceDto): Promise<PlaceView> {
    const reply = await this.call<PlaceReply>('Save', toRequest(dto), user);
    return toView(reply.place);
  }

  /** Actualiza un lugar existente del usuario autenticado (404 si es de otro usuario). */
  async update(user: AuthenticatedUser, id: string, dto: UpdatePlaceDto): Promise<PlaceView> {
    const reply = await this.call<PlaceReply>('Update', { id, ...toRequest(dto) }, user);
    return toView(reply.place);
  }

  /** Elimina un lugar del usuario autenticado (404 si es de otro usuario). */
  async remove(user: AuthenticatedUser, id: string): Promise<void> {
    await this.call<RemovePlaceReply>('Remove', { id }, user);
  }

  /** Firma la identidad interna con el userId del JWT y ejecuta la llamada gRPC mapeando errores. */
  private async call<T>(
    method: string,
    request: Record<string, unknown>,
    user: AuthenticatedUser,
  ): Promise<T> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    try {
      return await this.placesGrpc.call<T>(method, request, meta);
    } catch (err) {
      throw mapGrpcError(err);
    }
  }
}

/** Mapea el cuerpo REST validado al request gRPC (subtitle "" cuando no se envió). */
function toRequest(dto: SavePlaceDto): Record<string, unknown> {
  return {
    kind: dto.kind,
    label: dto.label,
    subtitle: dto.subtitle ?? '',
    lat: dto.lat,
    lng: dto.lng,
  };
}

/** Convierte la respuesta gRPC a la vista pública (normaliza kind y subtitle vacío → null). */
function toView(place: SavedPlaceReply): PlaceView {
  return {
    id: place.id,
    kind: normalizeKind(place.kind),
    label: place.label,
    subtitle: place.subtitle ? place.subtitle : null,
    lat: place.lat,
    lng: place.lng,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt,
  };
}

function normalizeKind(kind: string): PlaceKind {
  return PLACE_KINDS.find((k) => k === kind) ?? 'FAVORITE';
}

/** Extrae el status numérico de un error gRPC (grpc-js lo adjunta como `.code`). */
function grpcStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/** Traduce el error gRPC del places-service al modelo de error público del BFF. */
function mapGrpcError(err: unknown): Error {
  const message = err instanceof Error ? err.message : 'Error en places-service';
  switch (grpcStatusOf(err)) {
    case GrpcStatus.INVALID_ARGUMENT:
      return new ValidationError(stripGrpcPrefix(message));
    case GrpcStatus.NOT_FOUND:
      return new NotFoundError(stripGrpcPrefix(message));
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return new ConflictError(stripGrpcPrefix(message));
    case GrpcStatus.UNAUTHENTICATED:
      return new UnauthorizedError(stripGrpcPrefix(message));
    default:
      return err instanceof Error ? err : new Error(message);
  }
}

/** grpc-js prefija el mensaje con "N CODE: ..."; dejamos solo el texto de dominio. */
function stripGrpcPrefix(message: string): string {
  const idx = message.indexOf(': ');
  return idx >= 0 ? message.slice(idx + 2) : message;
}
