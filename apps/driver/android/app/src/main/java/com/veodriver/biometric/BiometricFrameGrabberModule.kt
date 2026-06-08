package com.veodriver.biometric

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Módulo nativo de captura biométrica (frame-grabber REAL) sobre Camera2.
 *
 * Abre la cámara FRONTAL, captura una secuencia de fotogramas JPEG (o una sola foto para el
 * enrolamiento) y los devuelve en base64. Es el único dueño de la cámara durante la captura (abre y
 * libera la sesión por llamada), por lo que NO compite con WebRTC. Sin permiso de cámara rechaza con
 * un error claro; nunca devuelve imágenes vacías ni simuladas.
 */
class BiometricFrameGrabberModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  /** Captura `frameCount` fotogramas JPEG (base64) con `intervalMs` entre cada uno. */
  @ReactMethod
  fun captureFrames(frameCount: Int, intervalMs: Int, promise: Promise) {
    val count = frameCount.coerceIn(1, MAX_FRAMES)
    capture(
      count,
      intervalMs.coerceAtLeast(0),
      onSuccess = { frames ->
        val array = Arguments.createArray()
        frames.forEach { array.pushString(it) }
        promise.resolve(array)
      },
      onError = { promise.reject(ERR_CAPTURE, it) },
    )
  }

  /** Captura una sola foto JPEG (base64) para el enrolamiento. */
  @ReactMethod
  fun capturePhoto(promise: Promise) {
    capture(
      1,
      0,
      onSuccess = { frames -> promise.resolve(frames.first()) },
      onError = { promise.reject(ERR_CAPTURE, it) },
    )
  }

  /** Valida permiso/cámara y arranca la sesión de captura de `count` JPEG. */
  private fun capture(
    count: Int,
    intervalMs: Int,
    onSuccess: (List<String>) -> Unit,
    onError: (Throwable) -> Unit,
  ) {
    val context = reactApplicationContext
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      onError(SecurityException("Permiso de cámara no concedido"))
      return
    }

    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val cameraId = frontCameraId(manager)
    if (cameraId == null) {
      onError(IllegalStateException("No hay cámara frontal disponible"))
      return
    }

    CaptureSession(manager, cameraId, count, intervalMs, onSuccess, onError).start()
  }

  /** Devuelve el id de la cámara frontal (o cualquiera disponible como respaldo). */
  private fun frontCameraId(manager: CameraManager): String? =
    manager.cameraIdList.firstOrNull { id ->
      manager.getCameraCharacteristics(id)
        .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
    } ?: manager.cameraIdList.firstOrNull()

  /**
   * Sesión de captura encapsulada: gestiona el hilo de cámara, el `ImageReader` JPEG y la emisión de
   * `count` capturas espaciadas. Libera todos los recursos al terminar o ante error (una sola vez).
   */
  private class CaptureSession(
    private val manager: CameraManager,
    private val cameraId: String,
    private val count: Int,
    private val intervalMs: Int,
    private val onSuccess: (List<String>) -> Unit,
    private val onError: (Throwable) -> Unit,
  ) {
    private val thread = HandlerThread("veo-biometric-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private val frames = ArrayList<String>(count)
    private var camera: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var finished = false

    private val reader: ImageReader =
      ImageReader.newInstance(WIDTH, HEIGHT, ImageFormat.JPEG, count + 2).apply {
        setOnImageAvailableListener({ r -> onImage(r) }, handler)
      }

    @Suppress("MissingPermission")
    fun start() {
      try {
        manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
          override fun onOpened(device: CameraDevice) {
            camera = device
            createSession(device)
          }

          override fun onDisconnected(device: CameraDevice) =
            fail(IllegalStateException("Cámara desconectada"))

          override fun onError(device: CameraDevice, error: Int) =
            fail(IllegalStateException("Error de cámara: $error"))
        }, handler)
      } catch (error: Throwable) {
        fail(error)
      }
    }

    private fun createSession(device: CameraDevice) {
      try {
        @Suppress("DEPRECATION")
        device.createCaptureSession(
          listOf(reader.surface),
          object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) {
              captureSession = session
              scheduleCaptures(device, session)
            }

            override fun onConfigureFailed(session: CameraCaptureSession) =
              fail(IllegalStateException("No se pudo configurar la sesión de cámara"))
          },
          handler,
        )
      } catch (error: Throwable) {
        fail(error)
      }
    }

    /** Programa `count` capturas JPEG espaciadas `intervalMs`. */
    private fun scheduleCaptures(device: CameraDevice, session: CameraCaptureSession) {
      for (i in 0 until count) {
        handler.postDelayed({
          if (finished) return@postDelayed
          try {
            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
              addTarget(reader.surface)
              set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
              set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
            }
            session.capture(request.build(), null, handler)
          } catch (error: Throwable) {
            fail(error)
          }
        }, i.toLong() * intervalMs)
      }
    }

    private fun onImage(reader: ImageReader) {
      var image: Image? = null
      try {
        image = reader.acquireNextImage() ?: return
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        val complete: Boolean
        synchronized(frames) {
          if (frames.size < count) {
            frames.add(Base64.encodeToString(bytes, Base64.NO_WRAP))
          }
          complete = frames.size >= count
        }
        if (complete) {
          succeed()
        }
      } catch (_: Throwable) {
        // Un frame corrupto no aborta la secuencia: se ignora y se espera el siguiente.
      } finally {
        image?.close()
      }
    }

    private fun succeed() {
      val captured = synchronized(frames) {
        if (finished) return
        finished = true
        ArrayList(frames)
      }
      release()
      if (captured.isEmpty()) {
        onError(IllegalStateException("La captura no produjo fotogramas"))
      } else {
        onSuccess(captured)
      }
    }

    private fun fail(error: Throwable) {
      synchronized(frames) {
        if (finished) return
        finished = true
      }
      release()
      onError(error)
    }

    /** Libera cámara, sesión, reader y el hilo de cámara (idempotente y tolerante a fallos). */
    private fun release() {
      try {
        captureSession?.close()
        camera?.close()
        reader.close()
      } catch (_: Throwable) {
        // Ignoramos errores de cierre: el objetivo es liberar la cámara pase lo que pase.
      }
      thread.quitSafely()
    }
  }

  companion object {
    const val NAME = "VeoBiometricFrameGrabber"
    private const val ERR_CAPTURE = "E_BIOMETRIC_CAPTURE"
    private const val MAX_FRAMES = 30
    private const val WIDTH = 640
    private const val HEIGHT = 480
  }
}
