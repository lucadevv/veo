import type {CreateYapeAffiliation, YapeAffiliationView} from '@veo/api-client';

/**
 * Abstracción del repositorio de AFILIACIÓN Yape On File (cobro automático). El `userId` lo deriva el
 * BFF del JWT; acá solo viajan los datos del titular. El estado canónico vive en el server
 * (`status`: NONE | PROCESS | ACTIVE | EXPIRED | REVOKED) y se aprueba en la app Yape vía `deepLink`.
 */
export interface AffiliationRepository {
  /**
   * GET /payments/affiliations/yape → estado actual de la afiliación. Devuelve `{status:'NONE'}` si el
   * pasajero no afilió. NUNCA expone `walletUid` (solo `phoneMasked`).
   */
  getYapeAffiliation(): Promise<YapeAffiliationView>;
  /**
   * POST /payments/affiliations/yape → alta. Body OPCIONAL: sin argumento manda `{}` (UN TAP, el server
   * arma todo del perfil); con `{documentType, document}` el server persiste el documento en el perfil y
   * afilia (primera vez). Devuelve el estado inicial (PROCESS) y, si el gateway lo soporta, un `deepLink`
   * para aprobar en la app Yape. El sandbox responde 409 honesto (→ `AffiliationUnsupportedError`).
   */
  createYapeAffiliation(
    input?: CreateYapeAffiliation,
  ): Promise<YapeAffiliationView>;
  /** DELETE /payments/affiliations/yape → baja (revocación local). Devuelve `{status:'REVOKED'}`. */
  revokeYapeAffiliation(): Promise<YapeAffiliationView>;
}
