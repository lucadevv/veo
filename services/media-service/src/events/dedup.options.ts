import type { EventDedupOptions } from '@veo/events';

/**
 * Namespace Redis de dedup de media-service, compartido por TODOS sus consumers Kafka
 * (MediaEventConsumer y ErasureConsumer). Nunca compartirlo con otro servicio.
 */
export const MEDIA_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:media:evt:' };
