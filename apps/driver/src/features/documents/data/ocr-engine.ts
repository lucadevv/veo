/**
 * Helper de plataforma (Lote 1 · onboarding sin-formularios): deriva el `OcrEngine` que produjo la data
 * extraída según la plataforma del device, para la TRAZABILIDAD del backend. Vive en `data/` (no en el
 * dominio puro) porque depende de `Platform.OS` de react-native (un detalle de plataforma, igual que el
 * resto de adaptadores nativos de esta carpeta).
 *
 * Mapeo (espeja el enum CERRADO `OcrEngine` de @veo/shared-types, sin string mágico):
 *  - iOS     → VisionKit on-device (`ios-visionkit`).
 *  - Android → ML Kit on-device   (`android-mlkit`).
 *  - Otras plataformas (no debería ocurrir: la app es iOS+Android) → `android-mlkit` como default seguro.
 *    Se elige Android porque es la plataforma de tablet de la flota (el grueso del parque); un default
 *    EXPLÍCITO evita un `undefined` que rompería la trazabilidad. NUNCA inventa un motor fuera del enum.
 */

import { Platform } from 'react-native';
import { OcrEngine } from '@veo/shared-types';

/** `OcrEngine` on-device de esta plataforma (iOS→VisionKit, Android/otros→ML Kit). */
export function ocrEngineForPlatform(): OcrEngine {
  return Platform.OS === 'ios' ? OcrEngine.IOS_VISIONKIT : OcrEngine.ANDROID_MLKIT;
}

/** Instante de la extracción OCR en ISO-8601 (lo que el contrato `ocrAt` espera). */
export function ocrTimestampNow(): string {
  return new Date().toISOString();
}
