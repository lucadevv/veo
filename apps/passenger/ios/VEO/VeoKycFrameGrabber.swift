//
//  VeoKycFrameGrabber.swift
//  Módulo nativo de captura de frames del KYC del PASAJERO (frame-grabber REAL) sobre AVFoundation.
//
//  Portado del módulo que ya funciona en la app del conductor (`VeoBiometricFrameGrabber`). Abre la
//  cámara FRONTAL, captura una secuencia de fotogramas JPEG y los devuelve en base64. Es el único
//  dueño de la cámara durante la captura (abre y libera la sesión por llamada), por lo que NO compite
//  con WebRTC: el JS libera el `MediaStream` del preview ANTES de invocar este módulo. Sin permiso de
//  cámara rechaza con un error claro; nunca devuelve imágenes vacías ni simuladas.
//

import AVFoundation
import CoreImage
import Foundation
import QuartzCore
import UIKit

@objc(VeoKycFrameGrabber)
class VeoKycFrameGrabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {

  private var session: AVCaptureSession?
  private var sampleQueue: DispatchQueue?
  private let ciContext = CIContext(options: nil)
  private var frames: [String] = []
  private var targetCount = 0
  private var intervalSeconds: TimeInterval = 0
  private var lastCaptureTime: TimeInterval = 0
  private var capturing = false
  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?

  private static let errCapture = "E_KYC_CAPTURE"
  private static let errNoPermission = "E_NO_CAMERA_PERMISSION"
  private static let maxFrames = 30

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// Captura `frameCount` fotogramas JPEG (base64) de la cámara frontal con `intervalMs` entre cada uno.
  @objc(captureFrames:intervalMs:resolver:rejecter:)
  func captureFrames(
    _ frameCount: NSNumber,
    intervalMs: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let count = max(1, min(frameCount.intValue, VeoKycFrameGrabber.maxFrames))
    startCapture(count: count, intervalMs: intervalMs.doubleValue, resolve: resolve, reject: reject)
  }

  private func startCapture(
    count: Int,
    intervalMs: Double,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    if capturing {
      reject(VeoKycFrameGrabber.errCapture, "Ya hay una captura de KYC en curso", nil)
      return
    }
    capturing = true
    targetCount = count
    intervalSeconds = max(0, intervalMs) / 1000.0
    lastCaptureTime = 0
    frames = []
    self.resolve = resolve
    self.reject = reject

    // Solicita/verifica el permiso de cámara (AVFoundation prompts con NSCameraUsageDescription).
    AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
      guard let self = self else { return }
      if !granted {
        self.fail(code: VeoKycFrameGrabber.errNoPermission, message: "Permiso de cámara denegado")
        return
      }
      self.configureAndStart()
    }
  }

  private func configureAndStart() {
    guard let device = frontCamera() else {
      fail(code: VeoKycFrameGrabber.errCapture, message: "No hay cámara frontal disponible")
      return
    }

    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: device)
    } catch {
      fail(code: VeoKycFrameGrabber.errCapture, message: error.localizedDescription)
      return
    }

    let session = AVCaptureSession()
    if session.canSetSessionPreset(.vga640x480) {
      session.sessionPreset = .vga640x480
    }
    if session.canAddInput(input) {
      session.addInput(input)
    }

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]
    let queue = DispatchQueue(label: "pe.veo.passenger.kyc.frames")
    output.setSampleBufferDelegate(self, queue: queue)
    if session.canAddOutput(output) {
      session.addOutput(output)
    }

    sampleQueue = queue
    self.session = session
    session.startRunning()
  }

  private func frontCamera() -> AVCaptureDevice? {
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera],
      mediaType: .video,
      position: .front
    )
    if let front = discovery.devices.first {
      return front
    }
    return AVCaptureDevice.default(for: .video)
  }

  // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard capturing else { return }
    // Throttle por intervalo: solo conservamos un frame cada `intervalSeconds`.
    let now = CACurrentMediaTime()
    if lastCaptureTime != 0, (now - lastCaptureTime) < intervalSeconds {
      return
    }
    lastCaptureTime = now

    guard let base64 = jpegBase64(from: sampleBuffer) else {
      return
    }
    frames.append(base64)
    if frames.count >= targetCount {
      succeed()
    }
  }

  private func jpegBase64(from sampleBuffer: CMSampleBuffer) -> String? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return nil
    }
    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
    guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
      return nil
    }
    let image = UIImage(cgImage: cgImage)
    guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
      return nil
    }
    return jpeg.base64EncodedString()
  }

  // MARK: - Resolución

  private func succeed() {
    guard capturing else { return }
    let captured = frames
    let resolve = self.resolve
    let reject = self.reject
    teardown()
    if captured.isEmpty {
      reject?(VeoKycFrameGrabber.errCapture, "La captura no produjo fotogramas", nil)
      return
    }
    // `captureFrames` siempre resuelve un array de base64; el JS mapea cada uno a un `KycFrame`.
    resolve?(captured)
  }

  private func fail(code: String, message: String) {
    let reject = self.reject
    teardown()
    reject?(code, message, nil)
  }

  private func teardown() {
    capturing = false
    if let session = session {
      session.stopRunning()
      self.session = nil
    }
    sampleQueue = nil
    resolve = nil
    reject = nil
    frames = []
  }
}
