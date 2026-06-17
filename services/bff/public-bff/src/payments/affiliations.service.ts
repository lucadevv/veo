/**
 * Proxy de afiliación Yape On File (L2 · UN TAP, patrón PedidosYa). El BFF delega los tres comandos al
 * payment-service por REST interno FIRMADO (InternalRestClient): la identidad del usuario (validada por el
 * BFF vía JWT) viaja como cabecera HMAC, NUNCA el JWT crudo. El payment-service la verifica con
 * InternalIdentityGuard y resuelve el userId DESDE la identidad firmada — el cliente jamás elige a qué
 * usuario afiliar (anti-IDOR by construction). Ninguna respuesta incluye walletUid.
 *
 * ALTA (UN TAP): el documento vive en el PERFIL (ProntoPaga lo recomienda: documento en perfil, nunca en
 * checkout). El body es TODO opcional:
 *  - Con {documentType, document} → el BFF PRIMERO los guarda en el perfil (PATCH interno a identity con la
 *    identidad firmada del user) y luego afilia con ellos. Guardar PRIMERO es deliberado: si la afiliación
 *    falla, el documento YA quedó persistido y el siguiente intento es UN TAP sin re-pedirlo.
 *  - Sin body → lee el perfil: si tiene document+name afilia directo (UN TAP); si falta name → 422
 *    PROFILE_NAME_MISSING; si falta document → 422 PROFILE_DOCUMENT_MISSING (códigos distintos para que la
 *    app sepa qué campo pedir). El `clientName` SIEMPRE sale del perfil; origin=MOBILE (sin phone).
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import { type AuthenticatedUser } from '@veo/auth';
import { REST_IDENTITY, REST_PAYMENT } from '../infra/downstream.tokens';
import { type UserProfile } from '../users/dto/update-profile.dto';
import {
  ProfileDocumentMissingError,
  ProfileNameMissingError,
  type CreateYapeAffiliationDto,
  type YapeAffiliationView,
} from './dto/affiliations.dto';

/** Recurso REST interno de afiliación expuesto por payment-service (prefijo /api/v1). */
const YAPE_AFFILIATION_PATH = '/affiliations/yape';

@Injectable()
export class AffiliationsService {
  constructor(
    @Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
  ) {}

  /**
   * Alta/re-inicio de Yape On File (UN TAP). Si el body trae documento, lo guarda PRIMERO en el perfil y
   * lo usa; si no, lee el perfil. Resuelve el nombre del perfil y delega con origin=MOBILE (sin phone). El
   * payment-service devuelve {affiliationId, status, deepLink?}; el deepLink pasa TAL CUAL. walletUid no viene.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateYapeAffiliationDto,
  ): Promise<YapeAffiliationView> {
    // (a) Si el body trae el documento → guardarlo PRIMERO en el perfil (decisión: persistir antes de
    // afiliar, para que el dato quede aunque la afiliación falle). El identity-service re-valida la forma.
    let profile: UserProfile;
    if (dto.documentType && dto.document) {
      profile = await this.identityRest.patch<UserProfile>('/users/me', {
        identity: user,
        body: { documentType: dto.documentType, document: dto.document },
      });
    } else {
      profile = await this.identityRest.get<UserProfile>('/users/me', { identity: user });
    }

    // Nombre del titular = nombre del PERFIL (nunca del body). Sin nombre → 422 con code distinguible.
    const clientName = profile.name?.trim();
    if (!clientName) {
      throw new ProfileNameMissingError('Completá tu nombre en el perfil antes de afiliar Yape');
    }

    // (b) Documento del PERFIL. Sin documento → 422 con OTRO code (la app muestra el campo documento).
    const document = profile.document?.trim();
    const documentType = profile.documentType;
    if (!document || !documentType) {
      throw new ProfileDocumentMissingError(
        'Cargá tu documento en el perfil antes de afiliar Yape',
      );
    }

    return this.paymentRest.post<YapeAffiliationView>(YAPE_AFFILIATION_PATH, {
      identity: user,
      body: { document, documentType, clientName, origin: 'MOBILE' },
    });
  }

  /**
   * Estado de la afiliación del usuario. payment-service devuelve {affiliationId, status, wallet,
   * phoneMasked} o {status:'NONE'}. Cuando el estado es PROCESS, el payment-service hace un refresh
   * DEFENSIVO contra el proveedor (/show, throttled) para resolver ACTIVE sin depender del webhook.
   * phoneMasked pasa tal cual; jamás walletUid.
   */
  status(user: AuthenticatedUser): Promise<YapeAffiliationView> {
    return this.paymentRest.get<YapeAffiliationView>(YAPE_AFFILIATION_PATH, { identity: user });
  }

  /** Baja (cancel REAL en el proveedor + REVOKED local) de la afiliación. Devuelve {status:'REVOKED', ...}. */
  revoke(user: AuthenticatedUser): Promise<YapeAffiliationView> {
    return this.paymentRest.delete<YapeAffiliationView>(YAPE_AFFILIATION_PATH, { identity: user });
  }
}
