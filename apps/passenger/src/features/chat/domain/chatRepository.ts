import type { ChatMessage } from './entities';

/**
 * Abstracción del repositorio de Chat del viaje (DIP). Implementación real contra el public-bff
 * (`GET /trips/:id/messages`, `POST /trips/:id/messages`).
 */
export interface ChatRepository {
  /** GET /trips/:id/messages → historial en orden cronológico ascendente. */
  list(tripId: string): Promise<ChatMessage[]>;
  /** POST /trips/:id/messages → envía un mensaje; el bff fija remitente y devuelve el recurso creado. */
  send(tripId: string, body: string): Promise<ChatMessage>;
}
