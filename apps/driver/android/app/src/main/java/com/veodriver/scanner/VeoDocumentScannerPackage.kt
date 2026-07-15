package com.veodriver.scanner

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Package que registra el módulo nativo de escaneo de documentos ([VeoDocumentScannerModule]).
 *
 * Como es un módulo propio dentro de la app (no una librería autoenlazada), se añade manualmente en
 * `MainApplication.getPackages()`, siguiendo el mismo patrón que [com.veodriver.biometric].
 */
class VeoDocumentScannerPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(VeoDocumentScannerModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
