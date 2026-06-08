import type { TripVideoGrant } from '@veo/api-client';
import type { ComponentType } from 'react';

/**
 * Estado de la conexión del visor en vivo (distinto del indicador REC: REC refleja que la grabación
 * server-side está activa —obligatorio mostrarla durante el viaje—; este estado refleja si la VISTA
 * en vivo del pasajero está disponible, para no engañar con un panel en blanco bajo el REC).
 */
export type CabinViewerState = 'connecting' | 'live' | 'error';

/** Props del visor de video del habitáculo: recibe el grant (url + token LiveKit) del bff. */
export interface CabinVideoViewerProps {
  grant: TripVideoGrant;
  /** Reporta el estado real de la conexión en vivo para que el panel sea honesto (sin blanco mudo). */
  onStateChange?: (state: CabinViewerState) => void;
}

/**
 * Puerto del VISOR de video del habitáculo (WebRTC/LiveKit). El visor REAL (react-native-webrtc /
 * LiveKit) lo implementa la OLEADA NATIVA y se registra con `registerCabinVideoViewer`. Mientras no
 * exista, `CabinVideoPanel` muestra el contenedor con el indicador REC y un aviso de "sin video".
 *
 * Firma exacta para la oleada nativa:
 *   const Viewer: CabinVideoViewer = ({ grant }) => <LiveKitRoom url={grant.url} token={grant.token} .../>;
 *   registerCabinVideoViewer(Viewer);
 */
export type CabinVideoViewer = ComponentType<CabinVideoViewerProps>;

let registered: CabinVideoViewer | null = null;

/** Registra el visor real (lo invoca la oleada nativa al iniciar la app). */
export function registerCabinVideoViewer(viewer: CabinVideoViewer): void {
  registered = viewer;
}

/** Devuelve el visor registrado o null si aún no hay implementación nativa. */
export function getCabinVideoViewer(): CabinVideoViewer | null {
  return registered;
}
