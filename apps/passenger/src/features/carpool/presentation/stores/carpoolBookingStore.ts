import {create} from 'zustand';
import {prefsStore} from '../../../../core/storage/mmkv';

/**
 * Booking ACTIVO de carpooling (el que está esperando la decisión del conductor). Store liviano
 * (Zustand) + cache MMKV: si el pasajero vuelve al inicio mientras espera (el poll de la pantalla
 * de estado se corta al desmontar), la app conserva el bookingId y le ofrece RE-ENTRAR al
 * seguimiento desde "Mis viajes programados" — incluso tras cerrar la app (por eso MMKV, no solo
 * memoria). Se limpia cuando la solicitud llega a un estado terminal (cobrada o no confirmada).
 */
const KEY = 'carpool.activeBookingId';

interface CarpoolBookingState {
  /** Id de MI solicitud en curso; null = ninguna. */
  activeBookingId: string | null;
  /** Marca la solicitud recién creada como activa (persistente). */
  setActiveBooking: (bookingId: string) => void;
  /** Limpia el seguimiento (la solicitud llegó a estado terminal). */
  clearActiveBooking: () => void;
}

export const useCarpoolBookingStore = create<CarpoolBookingState>(set => ({
  activeBookingId: prefsStore.getString(KEY) ?? null,
  setActiveBooking: bookingId => {
    prefsStore.setString(KEY, bookingId);
    set({activeBookingId: bookingId});
  },
  clearActiveBooking: () => {
    prefsStore.remove(KEY);
    set({activeBookingId: null});
  },
}));
