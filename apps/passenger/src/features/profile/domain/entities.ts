// Entidades de dominio de Profile (contrato soberano en @veo/api-client).
export type {PassengerProfile, UpdatePassengerProfile} from '@veo/api-client';

/**
 * Resultado de solicitar el borrado de cuenta (derecho al olvido, POST /users/me/deletion).
 * Contrato soberano en `@veo/api-client` (`deletionRequestResult`); se re-exporta como entidad de
 * dominio para no duplicar la forma.
 */
export type {DeletionRequestResult as AccountDeletionRequest} from '@veo/api-client';
