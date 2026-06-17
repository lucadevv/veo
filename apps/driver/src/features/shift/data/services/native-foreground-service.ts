import { NativeModules, Platform } from 'react-native';
import type {
  ForegroundServiceOptions,
  ForegroundServicePort,
} from '../../domain/ports/foreground-service';

/** Contrato del módulo nativo Android (`ShiftForegroundModule`). */
interface ShiftForegroundNativeModule {
  start(title: string | null, text: string | null): Promise<boolean>;
  stop(): Promise<boolean>;
}

/** Acceso tipado al módulo nativo (undefined en iOS o si no está enlazado). */
const nativeModule = NativeModules.ShiftForegroundService as
  | ShiftForegroundNativeModule
  | undefined;

/**
 * Implementación del Foreground Service sobre el módulo nativo Android.
 *
 * En iOS (o si el módulo nativo no está enlazado) hace no-op: el sistema mantiene la app viva en
 * background mediante los `UIBackgroundModes`. No es un mock: simplemente la plataforma no requiere
 * un servicio explícito.
 */
export class NativeForegroundService implements ForegroundServicePort {
  async start(options?: ForegroundServiceOptions): Promise<void> {
    if (Platform.OS !== 'android' || !nativeModule) {
      return;
    }
    await nativeModule.start(options?.title ?? null, options?.text ?? null);
  }

  async stop(): Promise<void> {
    if (Platform.OS !== 'android' || !nativeModule) {
      return;
    }
    await nativeModule.stop();
  }
}

/** Singleton del Foreground Service para inyectar en el contenedor de DI. */
export const nativeForegroundService: ForegroundServicePort = new NativeForegroundService();
