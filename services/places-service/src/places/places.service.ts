/**
 * PlacesService — reglas de negocio de lugares guardados (server-side). Espeja el dominio de la app
 * (veo-passenger-app · features/places: LocalPlacesRepository + usecases.validate), pero con el userId
 * SIEMPRE provisto por el contexto autenticado (nunca por el cliente) y persistencia en Postgres.
 *
 * Reglas (FOUNDATION §7, regla 7 de CLAUDE.md — testeadas en places.service.spec.ts):
 *  - HOME y WORK son ÚNICOS por usuario: al guardar, si ya existe uno del mismo kind → REEMPLAZA (upsert).
 *  - FAVORITE: múltiples, pero MÁX `maxFavorites` por usuario → si excede, rechaza (FavoritesLimitError).
 *  - Listado ORDENADO: HOME, luego WORK, luego FAVORITEs por createdAt desc.
 *  - Validación: label 1..maxLabel (trim, con default Casa/Trabajo), lat/lng finitos.
 *  - Aislamiento: update/remove sólo afectan lugares del propio userId (NOT_FOUND si es ajeno).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlaceKind, type SavedPlace } from '../generated/prisma';
import type { Env } from '../config/env.schema';
import { FavoritesLimitError, PlaceNotFoundError, PlaceValidationError } from './places.errors';
import { PLACES_REPO, type PlacesRepository } from './places.repository';

/** Entrada de creación/edición (sin id ni userId: el userId viene del contexto autenticado). */
export interface SavePlaceInput {
  kind: PlaceKind;
  label: string;
  subtitle?: string;
  lat: number;
  lng: number;
}

/** Orden de presentación de los tipos (Casa, Trabajo y al final favoritos). */
const KIND_ORDER: Record<PlaceKind, number> = {
  [PlaceKind.HOME]: 0,
  [PlaceKind.WORK]: 1,
  [PlaceKind.FAVORITE]: 2,
};

/** Etiqueta por defecto según el tipo (Casa/Trabajo); para favoritos se exige una propia. */
function defaultLabel(kind: PlaceKind): string | null {
  if (kind === PlaceKind.HOME) {
    return 'Casa';
  }
  if (kind === PlaceKind.WORK) {
    return 'Trabajo';
  }
  return null;
}

@Injectable()
export class PlacesService {
  private readonly maxFavorites: number;
  private readonly maxLabelLength: number;

  constructor(
    @Inject(PLACES_REPO) private readonly repo: PlacesRepository,
    config: ConfigService<Env, true>,
  ) {
    this.maxFavorites = config.getOrThrow<number>('MAX_FAVORITES');
    this.maxLabelLength = config.getOrThrow<number>('MAX_PLACE_LABEL_LENGTH');
  }

  /** Valida y normaliza la entrada (SRP: validación en el dominio, no en el controlador gRPC). */
  private validate(input: SavePlaceInput): SavePlaceInput {
    if (!Object.values(PlaceKind).includes(input.kind)) {
      throw new PlaceValidationError('kind');
    }
    // Etiqueta: prioriza la del cliente (trim); si queda vacía, usa el default del tipo (Casa/Trabajo).
    // Empleamos comparación explícita por vacío (no `||`) para no confundir "" con nullish.
    const trimmed = input.label?.trim() ?? '';
    const fallback = defaultLabel(input.kind) ?? '';
    const label = trimmed.length > 0 ? trimmed : fallback;
    if (label.length < 1 || label.length > this.maxLabelLength) {
      throw new PlaceValidationError('label');
    }
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
      throw new PlaceValidationError('point');
    }
    if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) {
      throw new PlaceValidationError('point');
    }
    return {
      kind: input.kind,
      label,
      lat: input.lat,
      lng: input.lng,
      ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
    };
  }

  /** Lista los lugares del usuario: HOME, WORK, luego FAVORITEs por createdAt desc. */
  async listByUser(userId: string): Promise<SavedPlace[]> {
    const places = await this.repo.findManyByUser(userId);
    return [...places].sort((a, b) => {
      const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (byKind !== 0) {
        return byKind;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  }

  /**
   * Guarda un lugar. HOME/WORK reemplazan el previo del mismo kind (upsert por userId+kind).
   * FAVORITE se agrega, rechazando si el usuario ya alcanzó el tope.
   */
  async save(userId: string, raw: SavePlaceInput): Promise<SavedPlace> {
    const input = this.validate(raw);
    const data = {
      userId,
      kind: input.kind,
      label: input.label,
      subtitle: input.subtitle ?? null,
      lat: input.lat,
      lng: input.lng,
    };

    // Read + write en UNA transacción SERIALIZABLE (la aísla el repo · runInTx): el count+create del
    // FAVORITE y el findFirst+create del HOME/WORK eran TOCTOU (dos saves concurrentes superaban el tope o
    // creaban dos HOME). Serializable serializa esas lecturas con el write; bajo carrera real (mismo usuario
    // y kind a la vez) uno falla honesto (serialization error) en vez de violar el invariante.
    return this.repo.runInTx(async (tx) => {
      if (input.kind === PlaceKind.FAVORITE) {
        const count = await tx.savedPlace.count({ where: { userId, kind: PlaceKind.FAVORITE } });
        if (count >= this.maxFavorites) {
          throw new FavoritesLimitError(this.maxFavorites);
        }
        return tx.savedPlace.create({ data });
      }
      // HOME/WORK únicos por usuario: si ya existe uno del mismo kind, se reemplaza (upsert manual,
      // porque el unique parcial userId+kind sólo cubre HOME/WORK y Prisma no expresa unique parcial).
      const existing = await tx.savedPlace.findFirst({ where: { userId, kind: input.kind } });
      if (existing) {
        return tx.savedPlace.update({ where: { id: existing.id }, data });
      }
      return tx.savedPlace.create({ data });
    });
  }

  /**
   * Edita un lugar existente del propio usuario. Si cambia a HOME/WORK y ya hay otro del mismo kind,
   * mantiene la unicidad reemplazando (borra el otro y deja éste). NOT_FOUND si el id no es del usuario.
   */
  async update(userId: string, id: string, raw: SavePlaceInput): Promise<SavedPlace> {
    const input = this.validate(raw);
    // findFirst + deleteMany + update en UNA transacción serializable (la aísla el repo · runInTx): el
    // deleteMany (unicidad HOME/WORK) y el update deben ser atómicos — sin la tx, un edit concurrente podía
    // borrar el registro en edición o dejar dos del mismo kind.
    return this.repo.runInTx(async (tx) => {
      const existing = await tx.savedPlace.findFirst({ where: { id, userId } });
      if (!existing) {
        throw new PlaceNotFoundError(id);
      }
      if (input.kind !== PlaceKind.FAVORITE) {
        // Garantiza unicidad de HOME/WORK: descarta cualquier otro del mismo kind del usuario.
        await tx.savedPlace.deleteMany({ where: { userId, kind: input.kind, id: { not: id } } });
      }
      return tx.savedPlace.update({
        where: { id: existing.id },
        data: {
          kind: input.kind,
          label: input.label,
          subtitle: input.subtitle ?? null,
          lat: input.lat,
          lng: input.lng,
        },
      });
    });
  }

  /** Elimina un lugar del propio usuario. NOT_FOUND si el id no existe o es ajeno. */
  async remove(userId: string, id: string): Promise<void> {
    const count = await this.repo.deleteByUser(id, userId);
    if (count === 0) {
      throw new PlaceNotFoundError(id);
    }
  }
}
