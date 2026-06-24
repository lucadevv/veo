import type { EventDedupOptions } from '@veo/events';

/**
 * Namespace Redis de dedup de fleet-service, para sus consumers Kafka (hoy: ErasureConsumer).
 * Nunca compartirlo con otro servicio (el dedup por eventId es per-servicio).
 */
export const FLEET_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:fleet:evt:' };
