package com.veodriver.foreground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Foreground Service obligatorio del turno/viaje (regla #3 de CLAUDE.md).
 *
 * Mantiene el proceso de la app en primer plano mientras el conductor está en turno o en un viaje
 * activo, de modo que Android NO mate el GPS ni la sesión WebRTC en background. Muestra una
 * notificación persistente (canal de baja prioridad) y declara los tipos de servicio en primer plano
 * (location/camera/microphone) según los permisos efectivamente concedidos.
 *
 * El control start/stop se hace desde JS vía `ShiftForegroundModule`.
 */
class ShiftForegroundService : Service() {

  // Servicio "started", no "bound": no exponemos binder.
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT

    ensureChannel()
    val notification = buildNotification(title, text)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // API 29+: se exige declarar el tipo de servicio en primer plano.
      startForeground(NOTIFICATION_ID, notification, resolveForegroundType())
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    // START_STICKY: si el sistema mata el servicio por presión de memoria, lo recrea.
    return START_STICKY
  }

  override fun onDestroy() {
    stopForegroundCompat()
    super.onDestroy()
  }

  /** Crea el canal de notificación (requerido en Android 8.0+). */
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = CHANNEL_DESCRIPTION
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  /** Construye la notificación persistente que abre la app al tocarla. */
  private fun buildNotification(title: String, text: String): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingFlags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(this, 0, it, pendingFlags)
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      // Ícono del sistema para no depender de un asset propio (evita romper el build).
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(contentIntent)
      .build()
  }

  /**
   * Calcula el bitmask de tipos de Foreground Service según los permisos concedidos.
   * Siempre incluye `location` (permiso declarado); añade `camera`/`microphone` solo si el usuario
   * los concedió, evitando una `SecurityException` al iniciar el servicio en Android 14+.
   */
  private fun resolveForegroundType(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return 0
    }
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (hasPermission(android.Manifest.permission.CAMERA)) {
        type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      }
      if (hasPermission(android.Manifest.permission.RECORD_AUDIO)) {
        type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      }
    }
    return type
  }

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  companion object {
    private const val CHANNEL_ID = "veo.driver.shift"
    private const val CHANNEL_NAME = "Turno activo"
    private const val CHANNEL_DESCRIPTION =
      "Mantiene el GPS y el video de seguridad activos mientras tu turno o viaje está en curso."
    private const val NOTIFICATION_ID = 1001

    const val EXTRA_TITLE = "veo.driver.foreground.title"
    const val EXTRA_TEXT = "veo.driver.foreground.text"
    const val DEFAULT_TITLE = "VEO Conductor"
    const val DEFAULT_TEXT = "Turno activo: compartiendo ubicación y seguridad."

    /** Arranca el servicio en primer plano de forma segura (startForegroundService en O+). */
    fun start(context: Context, title: String?, text: String?) {
      val intent = Intent(context, ShiftForegroundService::class.java).apply {
        putExtra(EXTRA_TITLE, title ?: DEFAULT_TITLE)
        putExtra(EXTRA_TEXT, text ?: DEFAULT_TEXT)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Detiene el servicio en primer plano. */
    fun stop(context: Context) {
      context.stopService(Intent(context, ShiftForegroundService::class.java))
    }
  }
}
