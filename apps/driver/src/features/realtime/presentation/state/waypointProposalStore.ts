import { create } from 'zustand';
import type { WaypointProposedMsg } from '@veo/api-client';

/**
 * Estado transitorio de la PARADA propuesta por el pasajero (socket `waypoint:proposed`, Lote C4). Vive
 * en Zustand (no es estado de servidor cacheable): el RealtimeManager la setea al recibir el push y la
 * pantalla del viaje activo la consume para ofrecer aceptar/rechazar. Una sola propuesta viva por vez
 * (el server garantiza una activa por viaje); una nueva pisa la anterior. Se limpia al responder o al
 * terminar el viaje. NO se persiste: si el conductor mata la app, la propuesta vence sola (TTL server).
 */
export interface WaypointProposalState {
  proposal: WaypointProposedMsg | null;
  setProposal(proposal: WaypointProposedMsg): void;
  /** Limpia la propuesta (el conductor respondió, venció, o cambió de viaje). */
  clearProposal(): void;
}

export const useWaypointProposalStore = create<WaypointProposalState>((set) => ({
  proposal: null,
  setProposal: (proposal) => set({ proposal }),
  clearProposal: () => set({ proposal: null }),
}));
