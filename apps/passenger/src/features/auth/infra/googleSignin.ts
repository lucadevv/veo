import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { GOOGLE_OAUTH } from './oauthConfig';

let configured = false;

/**
 * Configura el SDK nativo de Google Sign-In una sola vez (idempotente).
 *
 * `offlineAccess: false` → flujo SOLO de identidad: Google emite un `id_token` para el `webClientId`
 * (audience que el backend valida) sin pedir un `serverAuthCode` (que se usaría para acceso offline a
 * APIs de Google, algo que NO necesitamos: el backend solo verifica identidad). El `iosClientId`
 * habilita el flujo nativo en iOS (sin web view) y debe coincidir con el reversed URL scheme del
 * `Info.plist`.
 *
 * Llamar `configureGoogleSignin()` es seguro de invocar múltiples veces: solo configura una vez.
 */
export function configureGoogleSignin(): void {
  if (configured) {
    return;
  }
  GoogleSignin.configure({
    webClientId: GOOGLE_OAUTH.webClientId,
    iosClientId: GOOGLE_OAUTH.iosClientId,
    offlineAccess: false,
  });
  configured = true;
}
