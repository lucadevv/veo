package pe.veo.passenger.panic

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Detector OCULTO de la secuencia de pánico en Android (BR-S04): 3 pulsaciones de los botones de
 * volumen físicos en una ventana corta, SIN ninguna UI visible.
 *
 * Estrategia (dos fuentes, sin permisos especiales ni Accessibility):
 *  1. BroadcastReceiver dinámico sobre `android.media.VOLUME_CHANGED_ACTION`: el sistema lo emite con
 *     cada cambio de volumen. Funciona en primer plano Y en segundo plano / pantalla bloqueada
 *     MIENTRAS el proceso siga vivo.
 *  2. Eventos de tecla de `MainActivity.dispatchKeyEvent` (vía [onVolumeKeyFromActivity]): cubren el
 *     caso de primer plano cuando el volumen ya está en el tope (min/max) y el broadcast no se emite.
 *
 * El conteo de la secuencia vive aquí (nativo) y emite el evento `panicTriggered` a JS.
 *
 * LÍMITES REALES DE BACKGROUND (documentados): el receiver deja de recibir si el SISTEMA mata el
 * proceso. Durante un viaje, el foreground-service de `react-native-background-geolocation` mantiene
 * el proceso vivo, por lo que la detección sobrevive a la app en background / pantalla bloqueada. Sin
 * ese servicio activo (fuera de viaje) el SO puede suspender el proceso y dejar de notificar. Para
 * captura GLOBAL garantizada de teclas con la app cerrada haría falta un AccessibilityService que el
 * usuario debe habilitar manualmente (no se activa de forma silenciosa por política de la plataforma).
 */
class VolumePanicModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val pressTimestamps = ArrayDeque<Long>()
  private var lastPressAt = 0L
  private var armed = false

  private val volumeReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == VOLUME_CHANGED_ACTION) {
        registerPress()
      }
    }
  }

  init {
    instance = this
  }

  override fun getName(): String = MODULE_NAME

  /** Arma la detección registrando el receiver de cambios de volumen. */
  @ReactMethod
  fun start() {
    if (armed) return
    armed = true
    synchronized(pressTimestamps) { pressTimestamps.clear() }
    val filter = IntentFilter(VOLUME_CHANGED_ACTION)
    val context = reactApplicationContext
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // Receiver interno (no exportado): solo recibe broadcasts del propio sistema/app.
      context.registerReceiver(volumeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(volumeReceiver, filter)
    }
  }

  /** Detiene la detección y libera el receiver. */
  @ReactMethod
  fun stop() {
    if (!armed) return
    armed = false
    try {
      reactApplicationContext.unregisterReceiver(volumeReceiver)
    } catch (_: IllegalArgumentException) {
      // Ya estaba sin registrar: no-op.
    }
    synchronized(pressTimestamps) { pressTimestamps.clear() }
  }

  /** Requerido por NativeEventEmitter (JS). No-op: el emisor es nativo. */
  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
  }

  /** Requerido por NativeEventEmitter (JS). No-op. */
  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {
  }

  /** Entrada desde `MainActivity.dispatchKeyEvent` para pulsaciones en primer plano. */
  fun onVolumeKeyFromActivity() {
    if (armed) {
      registerPress()
    }
  }

  /** Registra una pulsación; si se completa la secuencia en la ventana, emite el evento a JS. */
  private fun registerPress() {
    val now = System.currentTimeMillis()
    if (now - lastPressAt < DEBOUNCE_MS) {
      return
    }
    lastPressAt = now

    val complete: Boolean
    synchronized(pressTimestamps) {
      pressTimestamps.addLast(now)
      while (pressTimestamps.isNotEmpty() && now - pressTimestamps.first() > WINDOW_MS) {
        pressTimestamps.removeFirst()
      }
      complete = pressTimestamps.size >= REQUIRED_PRESSES
      if (complete) {
        pressTimestamps.clear()
      }
    }

    if (complete) {
      emitTriggered()
    }
  }

  private fun emitTriggered() {
    if (!reactApplicationContext.hasActiveReactInstance()) {
      return
    }
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_NAME, null)
  }

  override fun invalidate() {
    stop()
    if (instance === this) {
      instance = null
    }
    super.invalidate()
  }

  companion object {
    private const val MODULE_NAME = "VeoPanicVolume"
    private const val EVENT_NAME = "panicTriggered"
    private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
    private const val REQUIRED_PRESSES = 3
    private const val WINDOW_MS = 2000L

    /** Anti-rebote entre las dos fuentes (broadcast + tecla) para no contar doble. */
    private const val DEBOUNCE_MS = 250L

    /** Referencia al módulo activo para que `MainActivity` le reenvíe las teclas de volumen. */
    @JvmStatic
    var instance: VolumePanicModule? = null
      private set
  }
}
