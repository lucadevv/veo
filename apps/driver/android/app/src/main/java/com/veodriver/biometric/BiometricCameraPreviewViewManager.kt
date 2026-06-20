package com.veodriver.biometric

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * ViewManager LEGACY ([SimpleViewManager]) de la vista de preview biométrica.
 *
 * El proyecto tiene la New Architecture activada (`newArchEnabled=true`), pero todos los componentes
 * nativos propios se registran como módulos/vistas LEGACY y RN los puentea automáticamente a Fabric vía
 * su capa de interoperabilidad (mismo patrón que `ShiftForegroundModule`). Por eso esta es una
 * `SimpleViewManager` (sin codegen spec): el menor riesgo y consistente con lo existente.
 *
 * Contrato para JS:
 *  - Componente nativo: `BiometricCameraPreview` (consumir con `requireNativeComponent`).
 *  - Prop `mirrored: boolean` (default true) — espeja SOLO la preview, no el archivo.
 *  - Eventos: `onCameraReady` (sin payload), `onCameraError` ({ code, message }).
 *  - Captura: se dispara desde el módulo `VeoBiometricFrameGrabber.capturePhoto()` (ya existente),
 *    que reusa la sesión de preview abierta cuando esta vista está montada.
 *
 * Para la interop de Fabric con eventos directos, el lado JS debe registrar el nombre del componente
 * en `unstable_reactLegacyComponentNames` (ver reporte del contrato nativo).
 */
class BiometricCameraPreviewViewManager(
  @Suppress("UNUSED_PARAMETER") reactContext: ReactApplicationContext,
) : SimpleViewManager<BiometricCameraPreviewView>() {

  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): BiometricCameraPreviewView =
    BiometricCameraPreviewView(reactContext)

  @ReactProp(name = "mirrored", defaultBoolean = true)
  fun setMirrored(view: BiometricCameraPreviewView, mirrored: Boolean) {
    view.mirrored = mirrored
  }

  override fun onDropViewInstance(view: BiometricCameraPreviewView) {
    super.onDropViewInstance(view)
    view.cleanup()
  }

  /** Mapea los eventos directos del view a callbacks de props de JS (onCameraReady / onCameraError). */
  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
    MapBuilder.builder<String, Any>()
      .put(
        BiometricCameraPreviewView.EVENT_READY,
        MapBuilder.of("registrationName", "onCameraReady"),
      )
      .put(
        BiometricCameraPreviewView.EVENT_ERROR,
        MapBuilder.of("registrationName", "onCameraError"),
      )
      .build()

  companion object {
    const val NAME = "BiometricCameraPreview"
  }
}
