/**
 * Errores de dominio de lugares guardados. Se mapean a códigos gRPC en el controlador
 * (INVALID_ARGUMENT para validación, RESOURCE_EXHAUSTED para el tope de favoritos, NOT_FOUND para
 * update/remove de un id ajeno o inexistente). Espejan la semántica del dominio de la app.
 */

/** Entrada inválida (label fuera de rango, lat/lng no finitos, kind desconocido). */
export class PlaceValidationError extends Error {
  constructor(readonly field: 'label' | 'point' | 'kind') {
    super(`Lugar inválido: ${field}`);
    this.name = 'PlaceValidationError';
  }
}

/** Se superó el tope de favoritos del usuario (BR: máx N favoritos). */
export class FavoritesLimitError extends Error {
  constructor(readonly max: number) {
    super(`Máximo ${max} lugares favoritos por usuario`);
    this.name = 'FavoritesLimitError';
  }
}

/** El lugar no existe o no pertenece al usuario autenticado (aislamiento por userId). */
export class PlaceNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Lugar no encontrado: ${id}`);
    this.name = 'PlaceNotFoundError';
  }
}
