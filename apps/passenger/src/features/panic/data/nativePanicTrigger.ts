import {
  type EmitterSubscription,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';
import type {PanicTrigger} from '../domain/panicTrigger';

/** Nombre del módulo nativo (Android: VolumePanicModule · iOS: VeoPanicVolume.swift). */
const NATIVE_MODULE_NAME = 'VeoPanicVolume';
/** Evento que el módulo nativo emite al completar la secuencia oculta (3× volumen). */
const TRIGGER_EVENT = 'panicTriggered';

interface VeoPanicVolumeNativeModule {
  start(): void;
  stop(): void;
  // Requeridos por NativeEventEmitter.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

/**
 * Implementación REAL del puerto `PanicTrigger` sobre el módulo nativo de detección por volumen.
 *
 * La DETECCIÓN (conteo de 3 pulsaciones en ventana corta, soporte de background) vive en nativo
 * (Kotlin/Swift). Aquí solo se suscribe al evento `panicTriggered` y se arranca/detiene el detector.
 * Si el módulo nativo no está disponible (p. ej. en un entorno sin la capa nativa), degrada a no-op
 * sin romper la app: el acceso al pánico sigue disponible de forma MANUAL desde la pantalla.
 */
export class NativePanicTrigger implements PanicTrigger {
  private subscription: EmitterSubscription | null = null;
  private readonly nativeModule: VeoPanicVolumeNativeModule | null;
  private readonly emitter: NativeEventEmitter | null;

  constructor() {
    const candidate = (NativeModules as Record<string, unknown>)[
      NATIVE_MODULE_NAME
    ] as VeoPanicVolumeNativeModule | undefined;
    this.nativeModule = candidate ?? null;
    this.emitter = this.nativeModule
      ? new NativeEventEmitter(NativeModules[NATIVE_MODULE_NAME])
      : null;
  }

  start(onTriggered: () => void): void {
    if (!this.nativeModule || !this.emitter) {
      console.warn(
        '[panic] módulo nativo de volumen no disponible; detección automática inactiva',
      );
      return;
    }
    // Evita suscripciones duplicadas si se llama start dos veces.
    this.subscription?.remove();
    this.subscription = this.emitter.addListener(TRIGGER_EVENT, onTriggered);
    this.nativeModule.start();
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = null;
    this.nativeModule?.stop();
  }
}
