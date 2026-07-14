import { Linking } from 'react-native';

/**
 * Abre una URL externa (deepLink de wallet Yape/Plin, web de checkout) de forma SEGURA.
 *
 * EL BUG QUE RESUELVE: `Linking.openURL(scheme)` RECHAZA la promesa cuando el sistema no puede abrir el
 * esquema — típicamente porque la app destino (Yape) NO está instalada o el esquema es desconocido. Sin un
 * `catch`, ese rechazo sube como "unhandled promise rejection" y el conductor ve un error crudo al tocar
 * "Pagar con Yape". No usamos `canOpenURL` como guarda (poco fiable sin declarar el esquema nativo, fuera de
 * alcance): intentamos el `openURL` directo y CAPTURAMOS el rechazo, que es la señal real de que no se pudo.
 *
 * @returns `true` si el sistema aceptó abrir la URL; `false` si falló (app no instalada, esquema desconocido,
 *          URL vacía). El llamador decide el fallback honesto (banner + "Pagar desde el navegador" o copiar).
 */
export async function openExternalUrl(url: string | null | undefined): Promise<boolean> {
  if (!url) {
    return false;
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
