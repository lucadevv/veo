import type { ProfileRepository } from '../repositories/profile-repository';
import type { DeletionRequested } from '../entities';

/**
 * Caso de uso: solicita el borrado de la cuenta del conductor (derecho al olvido, Ley N.° 29733)
 * vía `POST /drivers/me/deletion`. identity registra la solicitud, arranca la gracia (30 días por
 * política `privacy.erasure`) y, vencida la gracia, el sweeper aplica el tombstone (anonimiza PII,
 * borra la biometría y revoca las sesiones). Devuelve `graceUntil` para informar hasta cuándo se
 * puede cancelar.
 */
export class RequestAccountDeletionUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(): Promise<DeletionRequested> {
    return this.repository.requestDeletion();
  }
}
