/**
 * Puerto de la fuente de GPS del dispositivo (background-geolocation NATIVO).
 *
 * El ENVÍO del GPS por el socket `/driver` (evento `location`) ya está cableado en la app
 * (`useLocationPublisher`); lo que falta es la FUENTE de muestras, que instala la oleada nativa
 * (foreground service + background-geolocation). Hasta entonces se usa `unavailableLocationSource`,
 * que no emite (no es un mock: simplemente no hay GPS nativo todavía).
 */

export interface LocationSample {
  lat: number;
  lon: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
  /** Timestamp ISO-8601 de la muestra. */
  ts: string;
}

export interface LocationSource {
  /** true cuando la oleada nativa instaló una fuente real de GPS. */
  readonly available: boolean;
  /**
   * Suscribe a muestras de GPS del SO. Devuelve una función para cancelar la suscripción.
   * Firma EXACTA esperada por la oleada nativa: `subscribe(listener): () => void`.
   */
  subscribe(listener: (sample: LocationSample) => void): () => void;
}

/** Fuente por defecto: sin GPS nativo. No emite muestras; el publisher la ignora con seguridad. */
export const unavailableLocationSource: LocationSource = {
  available: false,
  subscribe: () => () => undefined,
};
