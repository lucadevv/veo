import {
  ApiError,
  isGatewayCapabilityUnavailableError,
  type CreateYapeAffiliation,
  type HttpClient,
  type YapeAffiliationView,
  yapeAffiliationView,
} from '@veo/api-client';
import type { AffiliationRepository } from '../domain/affiliationRepository';
import {
  AffiliationDocumentMissingError,
  AffiliationProfileIncompleteError,
  AffiliationUnsupportedError,
  AffiliationUpstreamUnavailableError,
} from '../domain/affiliationUsecases';

/**
 * Códigos 422 del BFF (contrato server-side). `PROFILE_DOCUMENT_MISSING` → el perfil no tiene documento
 * (revelar el campo); cualquier otro 422 (en la práctica `PROFILE_NAME_MISSING`) → el perfil no tiene
 * nombre (CTA al perfil). No hardcodear el string en la presentación: se traduce a errores tipados aquí.
 */
const PROFILE_DOCUMENT_MISSING = 'PROFILE_DOCUMENT_MISSING';
/** Código 502 del BFF cuando el gateway de Yape (sandbox/Cloudflare) está caído transitoriamente. */
const UPSTREAM_UNAVAILABLE = 'UPSTREAM_UNAVAILABLE';

/** Implementación de `AffiliationRepository` contra el public-bff (`/payments/affiliations/yape`). */
export class HttpAffiliationRepository implements AffiliationRepository {
  constructor(private readonly http: HttpClient) {}

  getYapeAffiliation(): Promise<YapeAffiliationView> {
    return this.http.get('/payments/affiliations/yape', { schema: yapeAffiliationView });
  }

  async createYapeAffiliation(input?: CreateYapeAffiliation): Promise<YapeAffiliationView> {
    try {
      // Body OPCIONAL: sin documento → `{}` (UN TAP, el server lo resuelve del perfil); con documento →
      // el server lo persiste en el perfil y afilia (primera vez). El `{}` viaja explícito.
      return await this.http.post('/payments/affiliations/yape', {
        body: input ?? {},
        schema: yapeAffiliationView,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) {
        throw err;
      }
      // CAPACIDAD no habilitada para el comercio (422 `GATEWAY_CAPABILITY_UNAVAILABLE`): ProntoPaga no
      // tiene activado el producto de afiliación Yape On File en este comercio. NO es transitorio ni un
      // error del usuario: reintentar nunca funcionará hasta que el proveedor lo habilite (L0 comercial).
      // Lo traducimos a `AffiliationUnsupportedError` → banner INFO honesto y calmo ("la estamos
      // activando"), nunca error rojo ni "reintenta". Se chequea ANTES del branch genérico de 422
      // (PROFILE_*), porque comparte el status 422 pero NO es un campo faltante del perfil.
      if (isGatewayCapabilityUnavailableError(err)) {
        throw new AffiliationUnsupportedError();
      }
      // Compat: si el entorno aún respondiera 409 para "no soportado", lo tratamos igual de honesto.
      if (err.status === 409) {
        throw new AffiliationUnsupportedError();
      }
      // 422: el BFF resuelve documento+nombre del PERFIL. Distinguimos por `error.code`:
      //  - PROFILE_DOCUMENT_MISSING → el flujo de UN TAP no halló documento: la UI revela el campo.
      //  - PROFILE_NAME_MISSING → el perfil no tiene nombre: la UI ofrece un CTA al perfil.
      if (err.status === 422) {
        if (err.code === PROFILE_DOCUMENT_MISSING) {
          throw new AffiliationDocumentMissingError();
        }
        // PROFILE_NAME_MISSING (o cualquier 422 sin código documento) → completar nombre en el perfil.
        throw new AffiliationProfileIncompleteError();
      }
      // 502 UPSTREAM_UNAVAILABLE: Cloudflare/gateway del sandbox transitorio. Reintentable: la UI hace
      // un reintento automático y, si persiste, muestra un mensaje honesto (no críptico).
      if (err.status === 502 && err.code === UPSTREAM_UNAVAILABLE) {
        throw new AffiliationUpstreamUnavailableError();
      }
      throw err;
    }
  }

  revokeYapeAffiliation(): Promise<YapeAffiliationView> {
    return this.http.delete('/payments/affiliations/yape', { schema: yapeAffiliationView });
  }
}
