import {Linking} from 'react-native';

/**
 * Abre una URL externa (deepLink de wallet, web de checkout) de forma SEGURA.
 *
 * EL BUG QUE RESUELVE: en iOS, `Linking.openURL(scheme)` RECHAZA la promesa cuando el sistema no puede
 * abrir el esquema — típicamente porque la app destino (Yape) NO está instalada, o el esquema es
 * desconocido. Sin un `catch`, ese rechazo sube como "unhandled promise rejection" y el usuario ve un
 * error crudo al tocar "Pagar con Yape". (No usamos `canOpenURL` como guarda: en iOS es poco fiable sin
 * declarar el esquema en `LSApplicationQueriesSchemes` del Info.plist —tocar nativo está fuera de
 * alcance—, así que intentamos el `openURL` directo y CAPTURAMOS el rechazo, que es la señal real de que
 * no se pudo abrir.)
 *
 * @returns `true` si el sistema aceptó abrir la URL; `false` si falló (app no instalada, esquema
 *          desconocido, URL vacía). El llamador decide el fallback honesto (banner + "Pagar desde el
 *          navegador" si hay una urlPay web, o reintentar).
 */
export async function openExternalUrl(
  url: string | null | undefined,
): Promise<boolean> {
  if (!url) {
    return false;
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    // openURL RECHAZA si el device no puede abrir el esquema (Yape no instalada, esquema desconocido).
    // Lo tratamos como "no se pudo abrir" → el llamador muestra el aviso honesto, sin error crudo.
    return false;
  }
}
