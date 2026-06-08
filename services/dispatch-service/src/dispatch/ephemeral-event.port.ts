/**
 * Puerto de publicación de eventos EFÍMEROS directo a Kafka (B3).
 *
 * `dispatch.offered` es un ping efímero ("hay un bid al que podés responder"), backstopped por el poll
 * del conductor a `/bids/open`. NO necesita la durabilidad del OUTBOX transaccional: un board abierto a N
 * conductores escribiría N filas durables en Postgres por un ping descartable. Por eso se publica DIRECTO
 * al topic Kafka (fire-and-forget) por este puerto, NO por el outbox.
 *
 * Los eventos DURABLES de dispatch (`match_found`/`offer_accepted`/`no_offers`/`offer_made`) SIGUEN yendo
 * por el outbox-en-transacción (FOUNDATION §6) — este puerto es SOLO para el efímero.
 *
 * El consumidor (driver-bff) lee `dispatch.offered` del MISMO topic `dispatch` de Kafka, así que el cambio
 * de canal en el PRODUCTOR no lo afecta: sigue recibiendo el mismo envelope en el mismo topic.
 */
import type { EventEnvelope, EventType, EventPayload } from '@veo/events';

export const EPHEMERAL_EVENT_PUBLISHER = Symbol('EPHEMERAL_EVENT_PUBLISHER');

export interface EphemeralEventPublisher {
  /**
   * Publica un envelope DIRECTO al topic Kafka (sin outbox). `key` ordena por entidad (tripId).
   * Fire-and-forget: el caller la trata best-effort (un fallo NO rompe el broadcast).
   */
  publish<T extends EventType>(envelope: EventEnvelope<EventPayload<T>>, key: string): Promise<void>;
}
