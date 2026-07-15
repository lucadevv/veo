package com.veodriver.biometric

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Package que registra el módulo nativo del frame-grabber biométrico y la vista de preview en vivo.
 *
 * Como es un módulo propio dentro de la app (no una librería autoenlazada), se añade manualmente en
 * `MainApplication.getPackages()`. La vista `BiometricCameraPreview` es la primera ViewManager custom
 * del proyecto: se registra como ViewManager LEGACY y RN la puentea a Fabric vía interop (mismo patrón
 * de interop que los módulos legacy del proyecto).
 */
class BiometricFrameGrabberPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(BiometricFrameGrabberModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = listOf(BiometricCameraPreviewViewManager(reactContext))
}
