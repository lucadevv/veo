package com.veodriver.biometric

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.StreamConfigurationMap
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Size
import android.view.Surface
import androidx.core.content.ContextCompat
import kotlin.math.abs

/**
 * Controlador Camera2 COMPARTIDO de la cámara frontal biométrica.
 *
 * Es el dueño único del `CameraDevice` y de una sesión de captura de DOBLE superficie:
 *  - una superficie de PREVIEW en vivo (la `SurfaceTexture` del `TextureView` de la vista RN), que
 *    corre continua con un `repeating request` (`TEMPLATE_PREVIEW`);
 *  - un `ImageReader` JPEG para la captura de la foto (`TEMPLATE_STILL_CAPTURE`).
 *
 * Diseño de coordinación (contrato): hay UNA instancia process-wide ([instance]). La vista de preview
 * gobierna el lifecycle (abre cuando tiene `SurfaceTexture`, cierra al desmontarse). El módulo de
 * captura ([BiometricFrameGrabberModule]) NO abre su propia cámara cuando hay una preview activa: pide
 * el still capture sobre la sesión ya abierta vía [capturePhoto], manteniendo la preview viva. Si no
 * hay preview montada, el módulo cae a su captura autónoma (sin preview), preservando el flujo del alta.
 *
 * Resolución: se eligen tamaños desde el `StreamConfigurationMap` real del sensor (ver
 * [chooseJpegSize] / [choosePreviewSize]), no VGA fija.
 *
 * Orientación/espejo: el JPEG capturado sale DERECHO (upright) y bien orientado vía `JPEG_ORIENTATION`
 * calculado desde `SENSOR_ORIENTATION` + rotación del device, con la fórmula de cámara frontal. NO se
 * espeja el archivo (enroll y verify deben usar la misma "mano"). La preview puede mostrarse espejada
 * en la vista (selfie natural) sin afectar el archivo.
 *
 * Todos los recursos (cámara, sesión, reader, hilo) se liberan en [close] de forma idempotente.
 */
class BiometricCameraController private constructor(context: Context) {

  /** Estado observable de la preview para que la vista emita eventos a JS. */
  enum class State { IDLE, OPENING, READY, ERROR }

  /** Listener de la vista de preview: recibe transiciones de estado y errores tipados. */
  interface PreviewListener {
    fun onState(state: State)
    fun onError(code: String, message: String)
  }

  private val appContext: Context = context.applicationContext
  private val manager: CameraManager =
    appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager

  private var thread: HandlerThread? = null
  private var handler: Handler? = null

  private var cameraId: String? = null
  private var characteristics: CameraCharacteristics? = null
  private var camera: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var reader: ImageReader? = null

  private var previewSurface: Surface? = null
  private var previewSize: Size? = null
  private var jpegSize: Size? = null

  /** Rotación del display (Surface.ROTATION_*) que la vista provee para calcular `JPEG_ORIENTATION`. */
  @Volatile private var displayRotation: Int = Surface.ROTATION_0

  private var listener: PreviewListener? = null
  @Volatile private var state: State = State.IDLE

  /** Callback de la captura en curso (una a la vez); se limpia al resolver. */
  private var pendingCapture: ((Result<String>) -> Unit)? = null
  private var afConverged = false

  // ---------------------------------------------------------------------------------------------
  // API para la VISTA de preview
  // ---------------------------------------------------------------------------------------------

  /** Registra el listener de la vista (estado/errores). */
  @Synchronized
  fun setPreviewListener(listener: PreviewListener?) {
    this.listener = listener
    listener?.onState(state)
  }

  /** La vista informa la rotación actual del display para orientar correctamente el JPEG. */
  fun setDisplayRotation(rotation: Int) {
    displayRotation = rotation
  }

  /**
   * Arranca la preview sobre la `SurfaceTexture` del `TextureView`. Si no hay permiso de cámara o no
   * hay cámara frontal, emite un error tipado a la vista (NO crashea).
   */
  @Synchronized
  fun startPreview(texture: SurfaceTexture, viewWidth: Int, viewHeight: Int) {
    if (state == State.OPENING || state == State.READY) return
    if (!hasCameraPermission()) {
      emitError(ERR_PERMISSION, "Permiso de cámara no concedido")
      return
    }
    val id = frontCameraId()
    if (id == null) {
      emitError(ERR_NO_CAMERA, "No hay cámara frontal disponible")
      return
    }
    try {
      val chars = manager.getCameraCharacteristics(id)
      val map = chars.get(CameraCharacteristics.SCALE_STREAM_CONFIGURATION_MAP)
        ?: throw IllegalStateException("Sin StreamConfigurationMap")

      val jpeg = chooseJpegSize(map)
      val preview = choosePreviewSize(map, jpeg, viewWidth, viewHeight)

      cameraId = id
      characteristics = chars
      jpegSize = jpeg
      previewSize = preview

      // El buffer de la SurfaceTexture debe usar el tamaño de preview elegido (no el del view) para
      // evitar deformación/escalado raro del feed.
      texture.setDefaultBufferSize(preview.width, preview.height)
      previewSurface = Surface(texture)

      reader = ImageReader.newInstance(jpeg.width, jpeg.height, ImageFormat.JPEG, READER_BUFFERS).apply {
        setOnImageAvailableListener({ r -> onJpegAvailable(r) }, ensureHandler())
      }

      setState(State.OPENING)
      openCamera(id)
    } catch (error: Throwable) {
      emitError(ERR_CONFIG, error.message ?: "Error configurando la cámara")
    }
  }

  /** El tamaño de preview elegido (para que la vista ajuste el aspect ratio del TextureView). */
  @Synchronized
  fun previewSize(): Size? = previewSize

  /** Orientación del sensor en grados (para que la vista arme el [android.graphics.Matrix] del preview). */
  fun sensorOrientation(): Int =
    characteristics?.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0

  /** Indica si la sesión de preview está lista para capturar sin abrir una cámara nueva. */
  @Synchronized
  fun isPreviewReady(): Boolean = state == State.READY && session != null && camera != null

  /** Cierra la preview y libera todos los recursos. Idempotente. */
  @Synchronized
  fun stopPreview() {
    releaseInternal()
    setState(State.IDLE)
  }

  // ---------------------------------------------------------------------------------------------
  // API para el MÓDULO de captura
  // ---------------------------------------------------------------------------------------------

  /**
   * Dispara un still capture sobre la sesión de preview ABIERTA, asegurando convergencia de AF antes
   * de disparar. Devuelve el JPEG en base64 (mismo contrato que el módulo). Falla si no hay preview
   * lista o si ya hay una captura en curso.
   */
  @Synchronized
  fun capturePhoto(callback: (Result<String>) -> Unit) {
    val device = camera
    val sess = session
    val rdr = reader
    if (state != State.READY || device == null || sess == null || rdr == null) {
      callback(Result.failure(IllegalStateException("La preview no está lista para capturar")))
      return
    }
    if (pendingCapture != null) {
      callback(Result.failure(IllegalStateException("Ya hay una captura en curso")))
      return
    }
    pendingCapture = callback
    afConverged = false
    triggerAutoFocus(device, sess)
  }

  // ---------------------------------------------------------------------------------------------
  // Camera2 internals
  // ---------------------------------------------------------------------------------------------

  @Suppress("MissingPermission")
  private fun openCamera(id: String) {
    try {
      manager.openCamera(id, object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
          synchronized(this@BiometricCameraController) {
            camera = device
            createSession(device)
          }
        }

        override fun onDisconnected(device: CameraDevice) {
          emitError(ERR_CAMERA, "Cámara desconectada")
          stopPreview()
        }

        override fun onError(device: CameraDevice, error: Int) {
          emitError(ERR_CAMERA, "Error de cámara: $error")
          stopPreview()
        }
      }, ensureHandler())
    } catch (error: Throwable) {
      emitError(ERR_CAMERA, error.message ?: "No se pudo abrir la cámara")
    }
  }

  private fun createSession(device: CameraDevice) {
    val surfacePreview = previewSurface ?: return
    val rdr = reader ?: return
    try {
      @Suppress("DEPRECATION")
      device.createCaptureSession(
        listOf(surfacePreview, rdr.surface),
        object : CameraCaptureSession.StateCallback() {
          override fun onConfigured(configured: CameraCaptureSession) {
            synchronized(this@BiometricCameraController) {
              session = configured
              startRepeatingPreview(device, configured, surfacePreview)
              setState(State.READY)
            }
          }

          override fun onConfigureFailed(failed: CameraCaptureSession) {
            emitError(ERR_CONFIG, "No se pudo configurar la sesión de cámara")
          }
        },
        ensureHandler(),
      )
    } catch (error: Throwable) {
      emitError(ERR_CONFIG, error.message ?: "No se pudo crear la sesión")
    }
  }

  /** Preview continua: repeating request `TEMPLATE_PREVIEW` con AF continuo de imagen. */
  private fun startRepeatingPreview(
    device: CameraDevice,
    sess: CameraCaptureSession,
    surface: Surface,
  ) {
    val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
      addTarget(surface)
      set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
      set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
    }
    sess.setRepeatingRequest(request.build(), null, ensureHandler())
  }

  /**
   * Dispara `CONTROL_AF_TRIGGER_START` y espera el lock de AF en el callback antes del still capture,
   * para no sacar la foto desenfocada. Con timeout de respaldo: si AF no converge a tiempo, captura
   * igual (mejor una foto que un cuelgue).
   */
  private fun triggerAutoFocus(device: CameraDevice, sess: CameraCaptureSession) {
    val previewTarget = previewSurface ?: return
    val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
      addTarget(previewTarget)
      set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
      set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
      set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START)
    }

    val afCallback = object : CameraCaptureSession.CaptureCallback() {
      override fun onCaptureCompleted(
        s: CameraCaptureSession,
        request: CaptureRequest,
        result: TotalCaptureResult,
      ) {
        if (afConverged) return
        val afState = result.get(CaptureResult.CONTROL_AF_STATE)
        val locked = afState == null ||
          afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED ||
          afState == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED ||
          afState == CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED
        if (locked) {
          afConverged = true
          synchronized(this@BiometricCameraController) {
            val d = camera; val ss = session
            if (d != null && ss != null) captureStill(d, ss)
          }
        }
      }
    }

    try {
      sess.capture(builder.build(), afCallback, ensureHandler())
      // Respaldo: si AF no reporta lock dentro del timeout, capturamos igual.
      ensureHandler()?.postDelayed({
        if (!afConverged && pendingCapture != null) {
          afConverged = true
          synchronized(this@BiometricCameraController) {
            val d = camera; val ss = session
            if (d != null && ss != null) captureStill(d, ss)
          }
        }
      }, AF_TIMEOUT_MS)
    } catch (error: Throwable) {
      resolveCapture(Result.failure(error))
    }
  }

  /** Still capture sobre el `ImageReader`, manteniendo la preview viva. */
  private fun captureStill(device: CameraDevice, sess: CameraCaptureSession) {
    val rdr = reader
    if (rdr == null) {
      resolveCapture(Result.failure(IllegalStateException("Sin ImageReader")))
      return
    }
    try {
      val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
        addTarget(rdr.surface)
        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
        set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        set(CaptureRequest.JPEG_ORIENTATION, computeJpegOrientation())
      }
      sess.capture(request.build(), null, ensureHandler())
    } catch (error: Throwable) {
      resolveCapture(Result.failure(error))
    }
  }

  private fun onJpegAvailable(r: ImageReader) {
    var image: Image? = null
    try {
      image = r.acquireNextImage() ?: return
      val buffer = image.planes[0].buffer
      val bytes = ByteArray(buffer.remaining())
      buffer.get(bytes)
      resolveCapture(Result.success(Base64.encodeToString(bytes, Base64.NO_WRAP)))
    } catch (error: Throwable) {
      resolveCapture(Result.failure(error))
    } finally {
      image?.close()
    }
  }

  @Synchronized
  private fun resolveCapture(result: Result<String>) {
    val cb = pendingCapture ?: return
    pendingCapture = null
    afConverged = false
    cb(result)
  }

  // ---------------------------------------------------------------------------------------------
  // Orientación
  // ---------------------------------------------------------------------------------------------

  /**
   * Calcula `JPEG_ORIENTATION` para que el archivo salga DERECHO. Fórmula estándar de Camera2 para
   * cámara FRONTAL: RESTA la rotación del device al sensorOrientation (espejo del ángulo respecto a la
   * trasera, que SUMA). NO espejamos el archivo: el enrolado debe coincidir en "mano" con el verify
   * futuro.
   */
  private fun computeJpegOrientation(): Int {
    val sensorOrientation =
      characteristics?.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
    val deviceDegrees = rotationToDegrees(displayRotation)
    // Frontal: el sign-flip respecto a la trasera (que sería + deviceDegrees).
    return (sensorOrientation - deviceDegrees + FULL_TURN_DEGREES) % FULL_TURN_DEGREES
  }

  // ---------------------------------------------------------------------------------------------
  // Selección de tamaños
  // ---------------------------------------------------------------------------------------------

  /**
   * Elige un tamaño JPEG adecuado para una selfie de rostro: lado largo cercano a
   * [TARGET_CAPTURE_LONG_EDGE] (alto pero razonable), evitando el máximo del sensor (pesado). Si no
   * hay candidatos por debajo del objetivo, toma el menor disponible.
   */
  private fun chooseJpegSize(map: StreamConfigurationMap): Size {
    val sizes = map.getOutputSizes(ImageFormat.JPEG)?.toList().orEmpty()
    if (sizes.isEmpty()) return Size(TARGET_CAPTURE_LONG_EDGE, TARGET_CAPTURE_SHORT_EDGE)
    val withinBudget = sizes.filter { maxOf(it.width, it.height) <= TARGET_CAPTURE_LONG_EDGE }
    return if (withinBudget.isNotEmpty()) {
      withinBudget.maxByOrNull { it.width.toLong() * it.height } ?: withinBudget.first()
    } else {
      sizes.minByOrNull { it.width.toLong() * it.height } ?: sizes.first()
    }
  }

  /**
   * Elige un tamaño de preview compatible con el aspect ratio del JPEG y acotado a
   * [MAX_PREVIEW_LONG_EDGE], priorizando el que mejor matchea el aspect ratio de la captura para no
   * deformar el feed.
   */
  private fun choosePreviewSize(
    map: StreamConfigurationMap,
    jpeg: Size,
    viewWidth: Int,
    viewHeight: Int,
  ): Size {
    val candidates = map.getOutputSizes(SurfaceTexture::class.java)?.toList().orEmpty()
      .filter { maxOf(it.width, it.height) <= MAX_PREVIEW_LONG_EDGE }
    if (candidates.isEmpty()) return jpeg
    val targetRatio = jpeg.width.toDouble() / jpeg.height.toDouble()
    return candidates.minByOrNull { size ->
      val ratio = size.width.toDouble() / size.height.toDouble()
      abs(ratio - targetRatio)
    } ?: candidates.maxByOrNull { it.width.toLong() * it.height } ?: jpeg
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private fun hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(appContext, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED

  private fun frontCameraId(): String? =
    manager.cameraIdList.firstOrNull { id ->
      manager.getCameraCharacteristics(id)
        .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
    } ?: manager.cameraIdList.firstOrNull()

  private fun ensureHandler(): Handler? {
    if (handler == null) {
      thread = HandlerThread("veo-biometric-camera").apply { start() }
      handler = Handler(thread!!.looper)
    }
    return handler
  }

  private fun setState(next: State) {
    state = next
    listener?.onState(next)
  }

  private fun emitError(code: String, message: String) {
    state = State.ERROR
    listener?.onError(code, message)
    listener?.onState(State.ERROR)
  }

  /** Libera cámara, sesión, reader, surface y el hilo de cámara (idempotente, tolerante a fallos). */
  @Synchronized
  private fun releaseInternal() {
    pendingCapture?.invoke(Result.failure(IllegalStateException("Cámara cerrada durante la captura")))
    pendingCapture = null
    try {
      session?.close()
    } catch (_: Throwable) {
    }
    session = null
    try {
      camera?.close()
    } catch (_: Throwable) {
    }
    camera = null
    try {
      reader?.close()
    } catch (_: Throwable) {
    }
    reader = null
    try {
      previewSurface?.release()
    } catch (_: Throwable) {
    }
    previewSurface = null
    thread?.quitSafely()
    thread = null
    handler = null
  }

  companion object {
    // Códigos de error tipados que llegan a JS vía evento onError de la vista.
    const val ERR_PERMISSION = "E_CAMERA_PERMISSION"
    const val ERR_NO_CAMERA = "E_NO_FRONT_CAMERA"
    const val ERR_CONFIG = "E_CAMERA_CONFIG"
    const val ERR_CAMERA = "E_CAMERA_DEVICE"

    // Objetivo de resolución de captura: selfie de rostro, alto pero razonable (no máximo del sensor).
    private const val TARGET_CAPTURE_LONG_EDGE = 1280
    private const val TARGET_CAPTURE_SHORT_EDGE = 960
    private const val MAX_PREVIEW_LONG_EDGE = 1280
    private const val READER_BUFFERS = 3
    private const val AF_TIMEOUT_MS = 1500L

    /** Vuelta completa en grados, para normalizar ángulos de orientación al rango [0, 360). */
    const val FULL_TURN_DEGREES = 360

    /** Mapea una rotación de display (`Surface.ROTATION_*`) a sus grados. */
    fun rotationToDegrees(rotation: Int): Int = when (rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }

    @Volatile private var instance: BiometricCameraController? = null

    /** Singleton process-wide compartido por la vista de preview y el módulo de captura. */
    fun get(context: Context): BiometricCameraController =
      instance ?: synchronized(this) {
        instance ?: BiometricCameraController(context).also { instance = it }
      }
  }
}
