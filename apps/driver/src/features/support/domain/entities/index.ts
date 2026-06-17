import type {
  CreateTicketRequest,
  SupportCategory,
  SupportStatus,
  SupportTicket,
  SupportTicketList,
} from '@veo/api-client';

/**
 * Entidades del dominio de soporte (Ola 2C). Re-exportan los contratos para que la presentación
 * dependa del dominio, no del paquete de API. El BFF fija `userId`/`role` desde la identidad; la app
 * solo envía categoría, asunto, cuerpo y opcionalmente el `tripId` del viaje relacionado.
 */
export type SupportTicketView = SupportTicket;
export type SupportTicketListView = SupportTicketList;
export type CreateTicketInput = CreateTicketRequest;
export type { SupportCategory, SupportStatus };
