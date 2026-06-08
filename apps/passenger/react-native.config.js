/**
 * react-native CLI config.
 *
 * `assets` declara las carpetas de fuentes de marca VEO (Clash Display + Outfit).
 * Al correr `npx react-native-asset` (o `react-native link`), la CLI copia los .ttf/.otf a
 *   - iOS: ios/VEO/ + registra cada archivo en UIAppFonts del Info.plist + los agrega al target Xcode.
 *   - Android: android/app/src/main/assets/fonts/.
 *
 * NOTA: en este repo el linking se hizo MANUAL (react-native-asset no está instalado):
 *   - iOS: fuentes en ios/VEO/Fonts/ + UIAppFonts ya poblado en Info.plist. Falta SOLO agregar la
 *     carpeta ios/VEO/Fonts al target en Xcode (Build Phases → Copy Bundle Resources) — paso manual.
 *   - Android: fuentes ya copiadas a android/app/src/main/assets/fonts/ (se empaquetan automáticamente).
 * Este `assets` queda declarado para que un futuro `npx react-native-asset` sea idempotente.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
  },
  assets: ['./assets/fonts'],
};
