import { MAX_PLACE_LABEL_LENGTH, type SavedPlace, type SavedPlaceInput } from './entities';
import type { PlacesRepository } from './placesRepository';

/** Error de validación de un lugar guardado. */
export class PlaceValidationError extends Error {
  constructor(readonly field: 'label' | 'point') {
    super(`Lugar inválido: ${field}`);
    this.name = 'PlaceValidationError';
  }
}

/** Etiqueta por defecto según el tipo (Casa/Trabajo); para favoritos se exige una propia. */
function defaultLabel(kind: SavedPlaceInput['kind']): string | null {
  if (kind === 'HOME') {
    return 'Casa';
  }
  if (kind === 'WORK') {
    return 'Trabajo';
  }
  return null;
}

/** Valida y normaliza la entrada (SRP: validación en el dominio, no en el widget). */
function validate(input: SavedPlaceInput): SavedPlaceInput {
  const fallback = defaultLabel(input.kind);
  const label = (input.label?.trim() || fallback || '').trim();
  if (label.length < 1 || label.length > MAX_PLACE_LABEL_LENGTH) {
    throw new PlaceValidationError('label');
  }
  if (
    !input.point ||
    !Number.isFinite(input.point.lat) ||
    !Number.isFinite(input.point.lng)
  ) {
    throw new PlaceValidationError('point');
  }
  return {
    kind: input.kind,
    label,
    point: { lat: input.point.lat, lng: input.point.lng },
    ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
  };
}

/** Lista los lugares guardados del pasajero. */
export class ListPlacesUseCase {
  constructor(private readonly repository: PlacesRepository) {}

  execute(): SavedPlace[] {
    return this.repository.list();
  }
}

/** Guarda un lugar nuevo (Casa/Trabajo reemplazan; favorito agrega). */
export class SavePlaceUseCase {
  constructor(private readonly repository: PlacesRepository) {}

  execute(input: SavedPlaceInput): SavedPlace {
    return this.repository.save(validate(input));
  }
}

/** Edita un lugar existente por id. */
export class UpdatePlaceUseCase {
  constructor(private readonly repository: PlacesRepository) {}

  execute(id: string, input: SavedPlaceInput): SavedPlace {
    return this.repository.update(id, validate(input));
  }
}

/** Elimina un lugar guardado. */
export class RemovePlaceUseCase {
  constructor(private readonly repository: PlacesRepository) {}

  execute(id: string): void {
    this.repository.remove(id);
  }
}
