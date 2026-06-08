package pe.veo.passenger

import android.view.KeyEvent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import pe.veo.passenger.panic.VolumePanicModule

class MainActivity : ReactActivity() {

  /**
   * Nombre del componente principal registrado desde JavaScript. Debe coincidir
   * con el `name` de `app.json` ("VEO").
   */
  override fun getMainComponentName(): String = "VEO"

  /**
   * [ReactActivityDelegate] por defecto. Habilita New Architecture mediante el
   * flag [fabricEnabled].
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Reenvía las pulsaciones de volumen al detector de pánico (cubre el caso de primer plano,
   * incluso en los topes de volumen donde no se emite el broadcast del sistema). No consume el
   * evento: el volumen sigue funcionando con normalidad, manteniendo la detección OCULTA.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN &&
        (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP ||
            event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
      VolumePanicModule.instance?.onVolumeKeyFromActivity()
    }
    return super.dispatchKeyEvent(event)
  }
}
