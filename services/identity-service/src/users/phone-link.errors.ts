import { DomainError } from '@veo/utils';

/**
 * El teléfono ya pertenece a OTRO usuario. 409 con code propio `PHONE_TAKEN` (distinto del
 * `CONFLICT` genérico) para que la app lo discrimine. ANTI-ENUMERACIÓN: se lanza con el MISMO
 * shape y mensaje siempre que el número no sea del propio usuario — nunca revela a quién pertenece.
 */
export class PhoneTakenError extends DomainError {
  readonly code = 'PHONE_TAKEN';
  readonly httpStatus = 409;

  constructor() {
    super('Ese número ya está en uso.');
  }
}

/** Enmascara un teléfono para logs de auditoría (Ley 29733): +51******321. Nunca el número completo. */
export function maskPhone(phone: string): string {
  // Conserva prefijo +51 y los 3 últimos dígitos; el resto se oculta.
  const tail = phone.slice(-3);
  const head = phone.startsWith('+51') ? '+51' : '';
  return `${head}******${tail}`;
}
