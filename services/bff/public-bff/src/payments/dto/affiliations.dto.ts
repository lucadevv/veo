import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { DomainError } from '@veo/utils';

/**
 * Tipos de documento aceptados por ProntoPaga en Perú (espeja el DTO interno de payment-service).
 * DN = DNI (8 dígitos), CE = Carné de Extranjería, PP = Pasaporte.
 */
export const DocumentType = { DN: 'DN', CE: 'CE', PP: 'PP' } as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

/**
 * Valida `document` según `documentType` (DNI 8 dígitos · CE 9-12 dígitos · PP 6-12 alfanum).
 * Custom porque `@ValidateIf` de class-validator gobierna la propiedad COMPLETA (el último gana),
 * no decorador-a-decorador: encadenar varios @ValidateIf/@Matches no da la lógica condicional que se busca.
 */
@ValidatorConstraint({ name: 'documentMatchesType', async: false })
class DocumentMatchesType implements ValidatorConstraintInterface {
  private static readonly RULES: Record<DocumentType, RegExp> = {
    DN: /^\d{8}$/,
    CE: /^\d{9,12}$/,
    PP: /^[A-Za-z0-9]{6,12}$/,
  };

  validate(document: unknown, args: ValidationArguments): boolean {
    if (typeof document !== 'string') return false;
    const type = (args.object as CreateYapeAffiliationDto).documentType;
    const rule = type ? DocumentMatchesType.RULES[type] : undefined;
    return rule ? rule.test(document) : false;
  }

  defaultMessage(args: ValidationArguments): string {
    const type = (args.object as CreateYapeAffiliationDto).documentType;
    switch (type) {
      case 'DN':
        return 'document (DNI) debe tener exactamente 8 dígitos';
      case 'CE':
        return 'document (CE) debe tener 9-12 dígitos';
      case 'PP':
        return 'document (PP) debe tener 6-12 caracteres alfanuméricos';
      default:
        return 'documentType inválido o ausente';
    }
  }
}

/**
 * Body de POST /payments/affiliations/yape (alta de Yape On File · UN TAP, patrón PedidosYa).
 * AHORA TODO opcional: el documento vive en el PERFIL (ProntoPaga lo recomienda: documento en perfil,
 * nunca en checkout). El flujo es:
 *  - Body VACÍO  → el BFF lee documento+nombre del perfil y afilia directo (UN TAP). Si falta el nombre
 *    → 422 PROFILE_NAME_MISSING; si falta el documento → 422 PROFILE_DOCUMENT_MISSING (la app distingue).
 *  - Body con {documentType, document} → el BFF PRIMERO los guarda en el perfil (PATCH interno a identity)
 *    y luego afilia. Si se envía uno, se exigen AMBOS (la forma se valida según el tipo).
 * El `clientName` siempre sale del PERFIL (nunca del body). El userId sale del JWT (anti-IDOR).
 */
export class CreateYapeAffiliationDto {
  @ApiPropertyOptional({ enum: DocumentType, description: 'Tipo de documento (DN|CE|PP). Opcional.' })
  @IsOptional()
  @IsEnum(DocumentType, { message: 'documentType debe ser DN, CE o PP' })
  documentType?: DocumentType;

  /**
   * Número de documento (opcional). Si se envía, la forma depende del tipo:
   *  - DN (DNI): exactamente 8 dígitos.
   *  - CE: 9-12 dígitos (carné de extranjería).
   *  - PP (pasaporte): 6-12 alfanuméricos.
   * Requiere `documentType` presente (el validador per-tipo lo exige).
   */
  @ApiPropertyOptional({ description: 'Número de documento (forma según documentType)', example: '12345678' })
  @IsOptional()
  @Validate(DocumentMatchesType)
  document?: string;
}

/**
 * Errores 422 distinguibles del alta Yape de UN TAP. Extienden DomainError con httpStatus 422 y un
 * `code` PROPIO en el TOP-LEVEL del shape de error estándar del BFF ({ error: { code, ... } }), para que
 * la app sepa EXACTAMENTE qué campo del perfil completar (nombre vs documento) sin parsear el mensaje.
 * No reusamos UnprocessableEntityError porque su `code` es fijo ('UNPROCESSABLE_ENTITY') y no distingue.
 */
export class ProfileNameMissingError extends DomainError {
  readonly code = 'PROFILE_NAME_MISSING';
  readonly httpStatus = 422;
}

export class ProfileDocumentMissingError extends DomainError {
  readonly code = 'PROFILE_DOCUMENT_MISSING';
  readonly httpStatus = 422;
}

/**
 * Vista pública de la afiliación Yape. Espeja AffiliationView del payment-service: NUNCA incluye
 * walletUid ni PII completa. `status:'NONE'` cuando el usuario aún no afilió.
 */
export interface YapeAffiliationView {
  affiliationId?: string;
  status: string;
  wallet?: string;
  phoneMasked?: string | null;
  /** Solo en el alta: deep-link para aprobar la afiliación en la app Yape. */
  deepLink?: string;
}
