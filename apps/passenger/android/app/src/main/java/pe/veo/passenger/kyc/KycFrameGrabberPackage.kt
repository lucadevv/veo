package pe.veo.passenger.kyc

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Package que registra el módulo nativo del frame-grabber del KYC del pasajero.
 *
 * Como es un módulo propio dentro de la app (no una librería autoenlazada), se añade manualmente en
 * `MainApplication.getPackages()`.
 */
class KycFrameGrabberPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(KycFrameGrabberModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
