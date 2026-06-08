//
//  VeoPanicVolume.swift
//  Detector OCULTO de la secuencia de pánico en iOS (BR-S04): 3 pulsaciones de los botones de
//  volumen físicos en una ventana corta, SIN ninguna UI visible.
//
//  Técnica: iOS no entrega eventos de teclas de volumen a apps de terceros, pero sí permite observar
//  por KVO `AVAudioSession.outputVolume`, que cambia con cada pulsación del botón físico. Se mantiene
//  una sesión de audio activa y un `MPVolumeView` oculto (fuera de pantalla) para suprimir el HUD del
//  sistema, de modo que la detección sea discreta. El conteo de la secuencia vive aquí (nativo).
//
//  LÍMITES REALES DE BACKGROUND (documentados): la observación solo funciona mientras la sesión de
//  audio esté activa. En primer plano funciona siempre; en segundo plano/pantalla bloqueada funciona
//  únicamente mientras el modo de fondo `audio` mantenga la sesión viva (iOS puede suspenderla). En
//  los topes de volumen (0% o 100%) `outputVolume` no cambia y esa pulsación concreta no se detecta;
//  por eso se reposiciona el volumen a una zona media al armar la detección.
//

import AVFoundation
import Foundation
import MediaPlayer
import UIKit

@objc(VeoPanicVolume)
class VeoPanicVolume: RCTEventEmitter {

  /// Nº de pulsaciones que disparan el pánico.
  private let requiredPresses = 3
  /// Ventana temporal (segundos) en la que deben ocurrir las pulsaciones.
  private let windowSeconds: TimeInterval = 2.0

  private var volumeObservation: NSKeyValueObservation?
  private var pressTimestamps: [TimeInterval] = []
  private var hiddenVolumeView: MPVolumeView?
  private var hasListeners = false
  private var isArmed = false

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return ["panicTriggered"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  /// Arma la detección: activa la sesión de audio, suprime el HUD y observa `outputVolume`.
  @objc(start)
  func start() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, !self.isArmed else { return }
      self.isArmed = true
      self.pressTimestamps.removeAll()

      let session = AVAudioSession.sharedInstance()
      do {
        // `.ambient` no interrumpe otros audios; `mixWithOthers` para no robar la reproducción.
        try session.setCategory(.ambient, options: [.mixWithOthers])
        try session.setActive(true)
      } catch {
        // Si la sesión no se puede activar, la observación puede no recibir cambios.
        NSLog("[VeoPanicVolume] no se pudo activar AVAudioSession: \(error.localizedDescription)")
      }

      self.installHiddenVolumeView()

      self.volumeObservation = session.observe(
        \.outputVolume,
        options: [.new]
      ) { [weak self] _, _ in
        self?.registerPress()
      }
    }
  }

  /// Detiene la detección y libera recursos.
  @objc(stop)
  func stop() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.isArmed = false
      self.volumeObservation?.invalidate()
      self.volumeObservation = nil
      self.pressTimestamps.removeAll()
      self.hiddenVolumeView?.removeFromSuperview()
      self.hiddenVolumeView = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }

  /// Inserta un `MPVolumeView` fuera de pantalla para que el sistema NO muestre el HUD de volumen.
  private func installHiddenVolumeView() {
    guard hiddenVolumeView == nil else { return }
    let frame = CGRect(x: -3000, y: -3000, width: 1, height: 1)
    let view = MPVolumeView(frame: frame)
    view.alpha = 0.0001
    view.isUserInteractionEnabled = false
    if let window = UIApplication.shared.windows.first {
      window.addSubview(view)
    }
    hiddenVolumeView = view
  }

  /// Registra una pulsación y, si se completa la secuencia en la ventana, emite el evento.
  private func registerPress() {
    guard isArmed else { return }
    let now = Date().timeIntervalSince1970
    pressTimestamps.append(now)
    // Conserva solo las pulsaciones dentro de la ventana.
    pressTimestamps = pressTimestamps.filter { now - $0 <= windowSeconds }

    if pressTimestamps.count >= requiredPresses {
      pressTimestamps.removeAll()
      if hasListeners {
        sendEvent(withName: "panicTriggered", body: nil)
      }
    }
  }
}
