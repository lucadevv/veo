import { ApiError, type GeoPoint, type PanicTriggerResult } from '@veo/api-client';
import type { LocationProvider } from '../../../shared/location/domain/locationProvider';
import { uuidv7 } from '../../../shared/utils/uuid';
import { withTimeout } from '../../../shared/utils/withTimeout';
import type { PanicRepository } from './panicRepository';
import type { PanicSecretProvisioner } from './panicSecretProvisioner';
import type { PanicSigner } from './panicSigner';

/**
 * El backend responde 401 cuando la firma HMAC no valida (p. ej. tras rotar el secreto compartido).
 * El 401 por TOKEN expirado ya lo resuelve el `HttpClient` (refresh + reintento) antes de llegar
 * aquí, así que un 401 que se propaga indica firma inválida → conviene rotar la clave y reintentar.
 */
function isSignatureRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Tope para obtener el fix de GPS al disparar el pánico. Si el device no devuelve posición en este
 * tiempo (GPS sin fix, indoor, bajo coacción), NO colgamos para siempre: rechazamos y la UI degrada
 * con un mensaje claro. No se inventan coordenadas (regla: nunca data falsa).
 */
const PANIC_LOCATION_TIMEOUT_MS = 5000;

/**
 * Dispara una alerta de pánico real contra el bff (`POST /panic`). Orquesta (SRP):
 *  1. Aprovisiona el secreto HMAC si aún no está en el device (perezoso, primera vez).
 *  2. Obtiene la ubicación actual (puerto `LocationProvider`, oleada nativa).
 *  3. Genera un `dedupKey` (UUIDv7) para idempotencia ante reintentos.
 *  4. Firma el mensaje canónico (puerto `PanicSigner`, HMAC con el secreto real).
 *  5. Envía la alerta (idempotente vía dedupKey). Si el backend rechaza la firma (401), rota la
 *     clave UNA vez y reintenta con el mismo dedupKey.
 *
 * Si el puerto de ubicación/firma o el aprovisionamiento fallan, propaga el error para que la UI
 * degrade con un mensaje claro (nunca envía datos inventados).
 */
export class TriggerPanicUseCase {
  constructor(
    private readonly repository: PanicRepository,
    private readonly location: LocationProvider,
    private readonly signer: PanicSigner,
    private readonly provisioner: PanicSecretProvisioner,
  ) {}

  async execute(tripId: string): Promise<PanicTriggerResult> {
    // Asegura el secreto HMAC antes de firmar (lo descarga del backend si aún no está provisionado).
    await this.provisioner.ensureProvisioned();
    // Tope de tiempo: un getCurrentPosition() que cuelga dejaría el pánico en un spinner infinito
    // que nunca envía ni falla — el peor modo de falla justo en la ruta de seguridad.
    const geo = await withTimeout(
      this.location.getCurrentPosition(),
      PANIC_LOCATION_TIMEOUT_MS,
      'No pudimos obtener tu ubicación a tiempo',
    );
    // El panic-service exige UUIDv7 para dedupKey (rechaza otras versiones, BR-S04).
    const dedupKey = uuidv7();
    return this.signAndTrigger(tripId, dedupKey, geo, true);
  }

  /**
   * Firma el mensaje canónico y envía la alerta. Ante un 401 de firma rota la clave una sola vez
   * (`allowRefresh`) y reintenta con el MISMO dedupKey, manteniendo la idempotencia.
   */
  private async signAndTrigger(
    tripId: string,
    dedupKey: string,
    geo: GeoPoint,
    allowRefresh: boolean,
  ): Promise<PanicTriggerResult> {
    const signature = await this.signer.sign({ tripId, dedupKey, geo });
    try {
      return await this.repository.trigger({ tripId, dedupKey, geo, signature });
    } catch (error) {
      if (allowRefresh && isSignatureRejected(error)) {
        // Rotación: el secreto compartido cambió en el backend. Refresca y reintenta una vez.
        await this.provisioner.refresh();
        return this.signAndTrigger(tripId, dedupKey, geo, false);
      }
      throw error;
    }
  }
}
