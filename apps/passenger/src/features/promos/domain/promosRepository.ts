import type {PromoValidationView} from './entities';

/**
 * Abstracción del repositorio de Promociones (DIP). Implementación real contra el public-bff
 * (`POST /promos/validate`).
 */
export interface PromosRepository {
  /** POST /promos/validate → previsualiza el descuento de un cupón sobre una tarifa cotizada. */
  validate(code: string, fareCents: number): Promise<PromoValidationView>;
}
