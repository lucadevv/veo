package com.veodriver.biometric

import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.RCTEventEmitter

/**
 * Vista nativa RN que renderiza el feed EN VIVO de la cámara frontal biométrica dentro del árbol RN.
 *
 * Usa un [TextureView] (permite transformaciones como el espejo de la preview) y delega el manejo de
 * Camera2 al [BiometricCameraController] compartido. La vista gobierna el lifecycle: arranca la preview
 * cuando la `SurfaceTexture` está disponible y la detiene al desmontarse, evitando leaks.
 *
 * ESPEJO: solo la PREVIEW se muestra espejada (selfie natural). El archivo JPEG capturado por el
 * controller sale DERECHO (no espejado) — ver [BiometricCameraController.computeJpegOrientation].
 *
 * Eventos a JS: `onCameraReady` (cámara lista para capturar) y `onCameraError` (error tipado).
 */
class BiometricCameraPreviewView(context: Context) : TextureView(context),
  BiometricCameraController.PreviewListener {

  private val controller = BiometricCameraController.get(context)

  /** Prop `mirrored`: espeja la preview horizontalmente (default true para selfie natural). */
  var mirrored: Boolean = true
    set(value) {
      field = value
      configureTransform(width, height)
    }

  init {
    surfaceTextureListener = object : SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        controller.setPreviewListener(this@BiometricCameraPreviewView)
        controller.setDisplayRotation(currentDisplayRotation())
        controller.startPreview(texture, width, height)
        configureTransform(width, height)
      }

      override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
        // El cambio de tamaño suele acompañar una rotación del display: re-reportamos para mantener
        // coherente el JPEG_ORIENTATION de la captura con la orientación de la preview.
        controller.setDisplayRotation(currentDisplayRotation())
        configureTransform(width, height)
      }

      override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
        controller.stopPreview()
        controller.setPreviewListener(null)
        return true
      }

      override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
    }
  }

  /**
   * Arma el [Matrix] del `TextureView` para que el feed de Camera2 salga DERECHO y SIN ESTIRAR.
   *
   * Camera2 NO rota el preview solo: entrega el buffer en la orientación nativa del sensor (landscape).
   * El `TextureView` por defecto lo escala a la vista (portrait) deformándolo y dejándolo de costado.
   * Aquí lo corregimos en un solo Matrix:
   *  1. ROTACIÓN: giramos el surface por el ángulo relativo sensor↔display (lo que Camera2 no compensa).
   *  2. ASPECTO: cuando esa rotación es de 90°/270°, el buffer queda "cruzado" respecto a la vista
   *     (landscape dentro de portrait), así que escalamos sus dimensiones ya rotadas para LLENAR la
   *     vista (center-crop) sin estirar.
   *  3. ESPEJO: componemos `scaleX = -1` — SOLO en la PREVIEW, jamás en el archivo capturado.
   *
   * Si el surface aún no tiene tamaño o no hay [previewSize] del controller, no hace nada (no crashea).
   */
  private fun configureTransform(viewWidth: Int, viewHeight: Int) {
    if (viewWidth == 0 || viewHeight == 0) return
    val buffer = controller.previewSize() ?: return

    val displayDegrees = BiometricCameraController.rotationToDegrees(currentDisplayRotation())
    val sensorOrientation = controller.sensorOrientation()
    // Ángulo relativo sensor↔display (frontal): el que el TextureView debe rotar para enderezar el feed.
    val rotation =
      (sensorOrientation - displayDegrees + BiometricCameraController.FULL_TURN_DEGREES) %
        BiometricCameraController.FULL_TURN_DEGREES

    val centerX = viewWidth / 2f
    val centerY = viewHeight / 2f
    val matrix = Matrix()

    val viewRect = RectF(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
    // El buffer llega en orientación nativa del sensor (landscape): width=lado largo, height=lado corto.
    val bufferRect = RectF(0f, 0f, buffer.width.toFloat(), buffer.height.toFloat())
    bufferRect.offset(centerX - bufferRect.centerX(), centerY - bufferRect.centerY())

    val rotatedSideways = rotation == ROTATION_RIGHT_ANGLE || rotation == ROTATION_LEFT_ANGLE
    if (rotatedSideways) {
      // El buffer queda "cruzado" respecto a la vista (landscape dentro de portrait). Mapeamos el
      // buffer centrado a la vista y luego escalamos para LLENAR (center-crop) sin estirar: como tras
      // rotar 90°/270° los lados se intercambian, el factor usa las dimensiones del buffer cruzadas.
      matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL)
      val scale = maxOf(
        viewHeight.toFloat() / buffer.height,
        viewWidth.toFloat() / buffer.width,
      )
      matrix.postScale(scale, scale, centerX, centerY)
    }
    // Rotación sobre el centro (incluye el caso 180°, que no necesita corrección de aspecto).
    matrix.postRotate(rotation.toFloat(), centerX, centerY)

    // ESPEJO: solo en la preview (selfie natural). El archivo JPEG sale NO espejado.
    if (mirrored) {
      matrix.postScale(-1f, 1f, centerX, centerY)
    }

    setTransform(matrix)
  }

  private fun currentDisplayRotation(): Int {
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    return wm?.defaultDisplay?.rotation ?: Surface.ROTATION_0
  }

  // --- PreviewListener ---

  override fun onState(state: BiometricCameraController.State) {
    if (state == BiometricCameraController.State.READY) {
      emitEvent(EVENT_READY, Arguments.createMap())
    }
  }

  override fun onError(code: String, message: String) {
    val payload = Arguments.createMap().apply {
      putString("code", code)
      putString("message", message)
    }
    emitEvent(EVENT_ERROR, payload)
  }

  private fun emitEvent(name: String, payload: WritableMap) {
    val reactContext = context as? ReactContext ?: return
    reactContext.getJSModule(RCTEventEmitter::class.java)
      .receiveEvent(id, name, payload)
  }

  /** Limpieza defensiva si el view se desmonta sin destruir la SurfaceTexture. */
  fun cleanup() {
    controller.stopPreview()
    controller.setPreviewListener(null)
  }

  companion object {
    const val EVENT_READY = "onCameraReady"
    const val EVENT_ERROR = "onCameraError"

    // Ángulos rectos (en grados) que dejan el buffer "cruzado" respecto a la vista y exigen corrección
    // de aspecto. 180° no entra: ahí la vista y el buffer mantienen la misma orientación.
    private const val ROTATION_RIGHT_ANGLE = 90
    private const val ROTATION_LEFT_ANGLE = 270
  }
}
