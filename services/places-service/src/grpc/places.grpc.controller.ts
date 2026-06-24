/**
 * Controlador gRPC de places (paquete veo.places.v1.PlacesService).
 * CRUD de lugares guardados consumido por el public-bff (Lote B). El userId NO viene del cuerpo:
 * se extrae de la identidad interna firmada que el BFF propaga en la metadata (anti-IDOR).
 *
 * Mapeo de errores de dominio → códigos gRPC:
 *  - PlaceValidationError  → INVALID_ARGUMENT
 *  - FavoritesLimitError   → RESOURCE_EXHAUSTED
 *  - PlaceNotFoundError    → NOT_FOUND
 */
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, Payload, Ctx, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { createLogger, domainEventsTotal, BusinessEventResult } from '@veo/observability';
import { PlaceKind, type SavedPlace } from '../generated/prisma';
import { PlacesService, type SavePlaceInput } from '../places/places.service';
import {
  FavoritesLimitError,
  PlaceNotFoundError,
  PlaceValidationError,
} from '../places/places.errors';
import { requireInternalIdentity } from './internal-identity.grpc';

// ── Formas crudas del proto. proto-loader puede entregar el enum como string ('HOME') o como número
// (1) según la config del transporte; lo normalizamos en `toDomainKind` para ser robustos a ambos. ──
type ProtoKind = string | number;

interface SavePayload {
  kind: ProtoKind;
  label: string;
  subtitle: string;
  lat: number;
  lng: number;
}
interface UpdatePayload extends SavePayload {
  id: string;
}
interface RemovePayload {
  id: string;
}
interface PlaceMsg {
  id: string;
  kind: PlaceKind;
  label: string;
  subtitle: string;
  lat: number;
  lng: number;
  createdAt: string;
  updatedAt: string;
}

// Mapeo del enum del proto (string o número) al enum de dominio. PLACE_KIND_UNSPECIFIED(0) → null.
const KIND_BY_NAME: Record<string, PlaceKind> = {
  HOME: PlaceKind.HOME,
  WORK: PlaceKind.WORK,
  FAVORITE: PlaceKind.FAVORITE,
};
const KIND_BY_NUMBER: Record<number, PlaceKind> = {
  1: PlaceKind.HOME,
  2: PlaceKind.WORK,
  3: PlaceKind.FAVORITE,
};

function toDomainKind(raw: ProtoKind): PlaceKind | null {
  if (typeof raw === 'number') {
    return KIND_BY_NUMBER[raw] ?? null;
  }
  return KIND_BY_NAME[raw] ?? null;
}

@Controller()
export class PlacesGrpcController {
  private readonly logger = createLogger('places-service');

  constructor(
    private readonly places: PlacesService,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  @GrpcMethod('PlacesService', 'ListByUser')
  async listByUser(
    @Payload() _payload: unknown,
    @Ctx() meta: Metadata,
  ): Promise<{ places: PlaceMsg[] }> {
    const user = this.identity(meta);
    const rows = await this.places.listByUser(user.userId);
    return { places: rows.map(toMsg) };
  }

  @GrpcMethod('PlacesService', 'Save')
  async save(@Payload() payload: SavePayload, @Ctx() meta: Metadata): Promise<{ place: PlaceMsg }> {
    const user = this.identity(meta);
    const place = await this.run(() => this.places.save(user.userId, toInput(payload)));
    domainEventsTotal.inc({ event: 'place.saved', result: BusinessEventResult.OK });
    this.logger.info({ userId: user.userId, kind: place.kind, id: place.id }, 'place saved');
    return { place: toMsg(place) };
  }

  @GrpcMethod('PlacesService', 'Update')
  async update(
    @Payload() payload: UpdatePayload,
    @Ctx() meta: Metadata,
  ): Promise<{ place: PlaceMsg }> {
    const user = this.identity(meta);
    const place = await this.run(() =>
      this.places.update(user.userId, payload.id, toInput(payload)),
    );
    domainEventsTotal.inc({ event: 'place.updated', result: BusinessEventResult.OK });
    this.logger.info({ userId: user.userId, id: place.id }, 'place updated');
    return { place: toMsg(place) };
  }

  @GrpcMethod('PlacesService', 'Remove')
  async remove(
    @Payload() payload: RemovePayload,
    @Ctx() meta: Metadata,
  ): Promise<{ removed: boolean }> {
    const user = this.identity(meta);
    await this.run(() => this.places.remove(user.userId, payload.id));
    domainEventsTotal.inc({ event: 'place.removed', result: BusinessEventResult.OK });
    this.logger.info({ userId: user.userId, id: payload.id }, 'place removed');
    return { removed: true };
  }

  private identity(meta: Metadata): AuthenticatedUser {
    return requireInternalIdentity(meta, this.secret);
  }

  /** Ejecuta una operación de dominio y traduce los errores de dominio a códigos gRPC. */
  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw mapError(err);
    }
  }
}

function toInput(p: SavePayload): SavePlaceInput {
  const kind = toDomainKind(p.kind);
  if (kind === null) {
    throw new PlaceValidationError('kind');
  }
  return {
    kind,
    label: p.label,
    lat: p.lat,
    lng: p.lng,
    ...(p.subtitle ? { subtitle: p.subtitle } : {}),
  };
}

function toMsg(place: SavedPlace): PlaceMsg {
  return {
    id: place.id,
    kind: place.kind,
    label: place.label,
    subtitle: place.subtitle ?? '',
    lat: place.lat,
    lng: place.lng,
    createdAt: place.createdAt.toISOString(),
    updatedAt: place.updatedAt.toISOString(),
  };
}

function mapError(err: unknown): RpcException {
  if (err instanceof RpcException) {
    return err;
  }
  if (err instanceof PlaceValidationError) {
    return new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: err.message });
  }
  if (err instanceof FavoritesLimitError) {
    return new RpcException({ code: GrpcStatus.RESOURCE_EXHAUSTED, message: err.message });
  }
  if (err instanceof PlaceNotFoundError) {
    return new RpcException({ code: GrpcStatus.NOT_FOUND, message: err.message });
  }
  const message = err instanceof Error ? err.message : 'Error interno';
  return new RpcException({ code: GrpcStatus.INTERNAL, message });
}
