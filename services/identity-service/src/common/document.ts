/**
 * Validación y enmascarado del documento de identidad del pasajero (Perú · ProntoPaga · Yape On File).
 *
 * Criterio per-tipo (ÚNICA fuente de verdad en identity; espeja el `DocumentMatchesType` del public-bff
 * `payments/dto/affiliations.dto.ts` — mismo criterio, deliberadamente duplicado porque identity y el BFF
 * son servicios desacoplados sin un paquete de DTOs compartido; centralizar acá evita la 3ª copia y deja
 * la regla testeable):
 *   - DN (DNI):       exactamente 8 dígitos.
 *   - CE (carné ext): 9-12 dígitos.
 *   - PP (pasaporte): 6-12 alfanuméricos.
 */
import { registerDecorator, type ValidationOptions, type ValidationArguments } from 'class-validator';

/** Tipos de documento aceptados (espeja el enum Prisma `DocumentType`). */
export const DOCUMENT_TYPES = ['DN', 'CE', 'PP'] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/** Reglas de forma por tipo de documento. */
const DOCUMENT_RULES: Record<DocumentTypeValue, RegExp> = {
  DN: /^\d{8}$/,
  CE: /^\d{9,12}$/,
  PP: /^[A-Za-z0-9]{6,12}$/,
};

/** true si `document` cumple la forma exigida por `documentType`. */
export function isValidDocument(documentType: unknown, document: unknown): boolean {
  if (typeof documentType !== 'string' || typeof document !== 'string') return false;
  const rule = DOCUMENT_RULES[documentType as DocumentTypeValue];
  return rule ? rule.test(document) : false;
}

/**
 * Enmascara un documento para auditoría/log: conserva los últimos 2 caracteres y oculta el resto.
 * Ej. '12345678' → '******78'. Nunca devuelve el valor completo. Para entradas muy cortas (<3),
 * devuelve solo asteriscos. Acepta null/undefined → '∅'.
 */
export function maskDocument(document: string | null | undefined): string {
  if (document == null) return '∅';
  if (document.length <= 2) return '*'.repeat(document.length);
  return '*'.repeat(document.length - 2) + document.slice(-2);
}

/**
 * Decorador de propiedad: valida `document` SEGÚN el `documentType` hermano del DTO. Custom porque
 * la regla es condicional (depende de otra propiedad), algo que los decoradores sueltos no expresan.
 * Si `documentType` está ausente, falla (no se puede validar la forma sin el tipo).
 */
export function IsValidDocument(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidDocument',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const type = (args.object as { documentType?: unknown }).documentType;
          return isValidDocument(type, value);
        },
        defaultMessage(args: ValidationArguments): string {
          const type = (args.object as { documentType?: unknown }).documentType;
          switch (type) {
            case 'DN':
              return 'document (DNI) debe tener exactamente 8 dígitos';
            case 'CE':
              return 'document (CE) debe tener 9-12 dígitos';
            case 'PP':
              return 'document (PP) debe tener 6-12 caracteres alfanuméricos';
            default:
              return 'documentType es requerido para validar document (DN|CE|PP)';
          }
        },
      },
    });
  };
}
