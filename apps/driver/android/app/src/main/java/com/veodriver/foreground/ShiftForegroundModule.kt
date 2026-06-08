package com.veodriver.foreground

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Módulo nativo RN que expone el control del Foreground Service de turno a JavaScript.
 *
 * Compatible con la New Architecture vía la capa de interoperabilidad de RN 0.75 (módulo legacy
 * registrado por `ShiftForegroundPackage`). Métodos `start`/`stop` devuelven Promesas.
 */
class ShiftForegroundModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  /** Inicia el Foreground Service con la notificación persistente del turno/viaje. */
  @ReactMethod
  fun start(title: String?, text: String?, promise: Promise) {
    try {
      ShiftForegroundService.start(reactApplicationContext, title, text)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject(ERR_START, error)
    }
  }

  /** Detiene el Foreground Service (al finalizar turno o viaje). */
  @ReactMethod
  fun stop(promise: Promise) {
    try {
      ShiftForegroundService.stop(reactApplicationContext)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject(ERR_STOP, error)
    }
  }

  companion object {
    const val NAME = "ShiftForegroundService"
    private const val ERR_START = "E_FOREGROUND_START"
    private const val ERR_STOP = "E_FOREGROUND_STOP"
  }
}
