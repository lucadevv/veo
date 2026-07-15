#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <UIKit/UIKit.h>
#import "VeoBiometricCameraController.h"

/**
 * Módulo nativo de captura biométrica (frame-grabber REAL) sobre AVFoundation.
 *
 * Abre la cámara FRONTAL, captura una secuencia de fotogramas JPEG (o una sola foto para el
 * enrolamiento) y los devuelve en base64. Es el único dueño de la cámara durante la captura (abre y
 * libera la sesión por llamada), por lo que NO compite con WebRTC. Sin permiso de cámara rechaza con
 * un error claro; nunca devuelve imágenes vacías ni simuladas.
 */
@interface VeoBiometricFrameGrabber : NSObject <RCTBridgeModule, AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation VeoBiometricFrameGrabber {
  AVCaptureSession *_session;
  dispatch_queue_t _sampleQueue;
  CIContext *_ciContext;
  // iOS 17+: provee el ángulo de captura del sensor para orientar el buffer (coherente con Path A).
  // Tipado `id` para que el ivar sea seguro en el target 13.4 (la clase es API_AVAILABLE 17).
  id _rotationCoordinator;
  NSMutableArray<NSString *> *_frames;
  NSInteger _targetCount;
  NSTimeInterval _intervalSeconds;
  NSTimeInterval _lastCaptureTime;
  BOOL _capturing;
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
}

RCT_EXPORT_MODULE(VeoBiometricFrameGrabber)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

/** Captura `frameCount` fotogramas JPEG (base64) con `intervalMs` entre cada uno. */
RCT_EXPORT_METHOD(captureFrames:(nonnull NSNumber *)frameCount
                  intervalMs:(nonnull NSNumber *)intervalMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSInteger count = MAX(1, MIN(frameCount.integerValue, 30));
  [self startCaptureWithCount:count intervalMs:intervalMs.doubleValue resolver:resolve rejecter:reject];
}

/**
 * Captura una sola foto JPEG (base64) para el enrolamiento.
 *
 * COORDINACIÓN con la preview (paridad con Android `capturePhoto`): si hay una vista
 * `BiometricCameraPreview` montada y lista, REUSA su sesión abierta (still sobre la sesión compartida del
 * `VeoBiometricCameraController`, manteniendo la preview viva) — así el conductor SE VE antes de
 * capturar y NO se abre una segunda cámara. Si no hay preview activa (flujo de alta sin preview), cae a
 * la captura autónoma de abajo, preservando el contrato del módulo.
 */
RCT_EXPORT_METHOD(capturePhoto:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  VeoBiometricCameraController *controller = [VeoBiometricCameraController sharedController];
  if ([controller isPreviewReady]) {
    [controller capturePhotoBase64:^(NSString *base64, NSString *code, NSString *message) {
      if (base64 != nil) {
        resolve(base64);
      } else {
        reject(code ?: @"E_BIOMETRIC_CAPTURE", message ?: @"Fallo de captura sobre la preview", nil);
      }
    }];
    return;
  }
  [self startCaptureWithCount:1 intervalMs:0 resolver:resolve rejecter:reject];
}

- (void)startCaptureWithCount:(NSInteger)count
                   intervalMs:(double)intervalMs
                     resolver:(RCTPromiseResolveBlock)resolve
                     rejecter:(RCTPromiseRejectBlock)reject {
  if (_capturing) {
    reject(@"E_BIOMETRIC_CAPTURE", @"Ya hay una captura biométrica en curso", nil);
    return;
  }
  _capturing = YES;
  _targetCount = count;
  _intervalSeconds = MAX(0, intervalMs) / 1000.0;
  _lastCaptureTime = 0;
  _frames = [NSMutableArray arrayWithCapacity:count];
  _resolve = [resolve copy];
  _reject = [reject copy];

  // Solicita/verifica el permiso de cámara (AVFoundation prompts con NSCameraUsageDescription).
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                            completionHandler:^(BOOL granted) {
    if (!granted) {
      [self failWithCode:@"E_NO_CAMERA_PERMISSION" message:@"Permiso de cámara denegado"];
      return;
    }
    [self configureAndStart];
  }];
}

- (void)configureAndStart {
  @try {
    AVCaptureDevice *device = [self frontCamera];
    if (device == nil) {
      [self failWithCode:@"E_BIOMETRIC_CAPTURE" message:@"No hay cámara frontal disponible"];
      return;
    }

    NSError *inputError = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
    if (input == nil) {
      [self failWithCode:@"E_BIOMETRIC_CAPTURE"
                 message:inputError.localizedDescription ?: @"No se pudo abrir la cámara"];
      return;
    }

    AVCaptureSession *session = [[AVCaptureSession alloc] init];
    if ([session canSetSessionPreset:AVCaptureSessionPreset640x480]) {
      session.sessionPreset = AVCaptureSessionPreset640x480;
    }
    if ([session canAddInput:input]) {
      [session addInput:input];
    }

    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.alwaysDiscardsLateVideoFrames = YES;
    output.videoSettings = @{ (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA) };
    _sampleQueue = dispatch_queue_create("pe.veo.driver.biometric.frames", DISPATCH_QUEUE_SERIAL);
    [output setSampleBufferDelegate:self queue:_sampleQueue];
    if ([session canAddOutput:output]) {
      [session addOutput:output];
    }

    // CONSISTENCIA con Path A (sesión compartida): orientamos el BUFFER en la conexión usando el ángulo
    // REAL del sensor — el MISMO mecanismo que el still del controller — en vez del tag EXIF
    // `UIImageOrientationRight` que se usaba antes (mecanismo distinto e inconsistente). Así enroll
    // (preview/Path A) y este fallback autónomo (Path B) producen imágenes con la MISMA orientación y
    // "mano". El `UIImage` resultante se marca como `Up` porque el buffer ya viene derecho.
    AVCaptureConnection *videoConnection = [output connectionWithMediaType:AVMediaTypeVideo];
    if (videoConnection != nil) {
      if (@available(iOS 17.0, *)) {
        // Coordinator sin preview layer (nil): solo necesitamos el ángulo de captura del sensor.
        AVCaptureDeviceRotationCoordinator *coordinator =
            [[AVCaptureDeviceRotationCoordinator alloc] initWithDevice:device previewLayer:nil];
        CGFloat captureAngle = coordinator.videoRotationAngleForHorizonLevelCapture;
        if ([videoConnection isVideoRotationAngleSupported:captureAngle]) {
          videoConnection.videoRotationAngle = captureAngle;
        }
        _rotationCoordinator = coordinator;  // retenido hasta teardown (KVO no necesario: captura puntual)
      } else if (videoConnection.isVideoOrientationSupported) {
        videoConnection.videoOrientation = AVCaptureVideoOrientationPortrait;
      }
    }

    _ciContext = [CIContext contextWithOptions:nil];
    _session = session;
    [session startRunning];
  } @catch (NSException *exception) {
    [self failWithCode:@"E_BIOMETRIC_CAPTURE" message:exception.reason ?: @"Fallo de captura"];
  }
}

- (AVCaptureDevice *)frontCamera {
  AVCaptureDeviceDiscoverySession *discovery = [AVCaptureDeviceDiscoverySession
      discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ]
                            mediaType:AVMediaTypeVideo
                             position:AVCaptureDevicePositionFront];
  AVCaptureDevice *front = discovery.devices.firstObject;
  if (front != nil) {
    return front;
  }
  return [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
}

#pragma mark - AVCaptureVideoDataOutputSampleBufferDelegate

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (!_capturing) {
    return;
  }
  // Throttle por intervalo: solo conservamos un frame cada `_intervalSeconds`.
  NSTimeInterval now = CACurrentMediaTime();
  if (_lastCaptureTime != 0 && (now - _lastCaptureTime) < _intervalSeconds) {
    return;
  }
  _lastCaptureTime = now;

  NSString *base64 = [self jpegBase64FromSampleBuffer:sampleBuffer];
  if (base64 == nil) {
    return;
  }
  [_frames addObject:base64];
  if ((NSInteger)_frames.count >= _targetCount) {
    [self succeed];
  }
}

- (NSString *)jpegBase64FromSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  CVImageBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    return nil;
  }
  CIImage *ciImage = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  CGImageRef cgImage = [_ciContext createCGImage:ciImage fromRect:ciImage.extent];
  if (cgImage == NULL) {
    return nil;
  }
  // El buffer YA viene DERECHO: la conexión del video output fue orientada con el ángulo REAL del
  // sensor (coordinator iOS 17+ / `videoOrientation` en <17), igual que el still de Path A. Por eso el
  // `UIImage` se marca `Up` (sin re-rotar). Antes acá se forzaba `UIImageOrientationRight`, un
  // mecanismo EXIF distinto e inconsistente con Path A — eliminado para unificar la orientación.
  UIImage *image = [UIImage imageWithCGImage:cgImage
                                       scale:1.0
                                 orientation:UIImageOrientationUp];
  CGImageRelease(cgImage);
  NSData *jpeg = UIImageJPEGRepresentation(image, 0.8);
  if (jpeg == nil) {
    return nil;
  }
  return [jpeg base64EncodedStringWithOptions:0];
}

#pragma mark - Resolución

- (void)succeed {
  if (!_capturing) {
    return;
  }
  NSArray<NSString *> *captured = [_frames copy];
  RCTPromiseResolveBlock resolve = _resolve;
  RCTPromiseRejectBlock reject = _reject;
  NSInteger targetCount = _targetCount;
  [self teardown];
  if (captured.count == 0) {
    if (reject) {
      reject(@"E_BIOMETRIC_CAPTURE", @"La captura no produjo fotogramas", nil);
    }
    return;
  }
  if (resolve) {
    // `capturePhoto` espera un string; `captureFrames` espera un array. JS lo distingue por método.
    resolve(targetCount == 1 ? captured.firstObject : captured);
  }
}

- (void)failWithCode:(NSString *)code message:(NSString *)message {
  RCTPromiseRejectBlock reject = _reject;
  [self teardown];
  if (reject) {
    reject(code, message, nil);
  }
}

- (void)teardown {
  _capturing = NO;
  if (_session != nil) {
    [_session stopRunning];
    _session = nil;
  }
  _rotationCoordinator = nil;  // sin observers KVO acá: basta soltar la referencia.
  _resolve = nil;
  _reject = nil;
  _frames = nil;
}

@end
