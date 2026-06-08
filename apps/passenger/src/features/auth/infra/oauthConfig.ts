/**
 * Identificadores OAuth de la app pasajero (Sign in with Google).
 *
 * Estos Client IDs son PÚBLICOS por diseño (van embebidos en el binario y en el `Info.plist`):
 * identifican a la app ante Google, NO son secretos. El secreto vive en el backend, que verifica
 * SOBERANAMENTE el `idToken` contra el JWKS de Google. La app solo obtiene el token y lo reenvía.
 *
 * - `webClientId`  → también llamado *serverClientId*. Es el audience del `idToken` que el backend
 *   espera; con `offlineAccess: false` Google emite el `id_token` para ESTE audience.
 * - `iosClientId`  → identifica al cliente nativo iOS ante Google (flujo nativo, sin web view).
 *
 * El *reversed* del `iosClientId` es el URL scheme que va en `CFBundleURLTypes` del `Info.plist`
 * (`com.googleusercontent.apps.421526184282-nna35hfqa0fjuej3ja2ts96795bqpse8`).
 */
export const GOOGLE_OAUTH = {
  webClientId:
    '421526184282-sfg0u6jp63s92dr3j3aaoulmvg3fp750.apps.googleusercontent.com',
  iosClientId:
    '421526184282-nna35hfqa0fjuej3ja2ts96795bqpse8.apps.googleusercontent.com',
} as const;
