#import "VeoBiometricCameraController.h"
#import <UIKit/UIKit.h>

// Códigos de error tipados — CONTRATO EXACTO con Android/JS. NO cambiar.
NSString *const VeoBiometricErrorPermission = @"E_CAMERA_PERMISSION";
NSString *const VeoBiometricErrorNoFront = @"E_NO_FRONT_CAMERA";
NSString *const VeoBiometricErrorConfig = @"E_CAMERA_CONFIG";
NSString *const VeoBiometricErrorDevice = @"E_CAMERA_DEVICE";

/**
 * Ángulo de retrato canónico (en grados) usado SOLO como fallback en iOS < 17, donde no existe
 * `AVCaptureDeviceRotationCoordinator`. En iOS 17+ el ángulo viene del SENSOR vía el coordinator
 * (`videoRotationAngleForHorizonLevel*`), no de esta constante. No es un "número mágico": es el valor
 * documentado de retrato (`AVCaptureVideoOrientationPortrait` ≡ 90° desde el buffer del sensor) para el
 * branch deprecado.
 */
static const CGFloat kVeoBiometricPortraitFallbackAngle = 90.0;

/** Sentinel: ángulo "no disponible aún" (no hay coordinator/preview armados). */
static const CGFloat kVeoBiometricRotationAngleUnavailable = -1.0;

/**
 * Preset de captura para el still del KYC. NO usamos `AVCaptureSessionPresetPhoto` (resolución COMPLETA
 * del sensor, 12-48MP): genera un JPEG de varios MB cuyo base64 el backend rechaza con 413 (request too
 * large) y derrocha datos móviles. Una selfie para embedding facial (ArcFace) NO necesita más de ~1280px:
 * `1280x720` da buen detalle de rostro con payload chico (~200-400KB en base64, holgadamente <1MB).
 *
 * `kVeoBiometricCapturePresetPrimary` es el objetivo; `kVeoBiometricCapturePresetFallback` se usa si el
 * device no soporta el primario (vía `canSetSessionPreset:`). El fallback (`640x480`) coincide con el
 * preset del frame-grabber autónomo (Path B, `VeoBiometricFrameGrabber.m`): ambos quedan chicos.
 */
// Macros (no `NSString *const`): los presets de AVFoundation son símbolos externos, no constantes
// compile-time, así que no pueden inicializar una variable estática a nivel de archivo.
#define kVeoBiometricCapturePresetPrimary AVCaptureSessionPreset1280x720
#define kVeoBiometricCapturePresetFallback AVCaptureSessionPreset640x480

@interface VeoBiometricCameraController () <AVCapturePhotoCaptureDelegate>
@end

@implementation VeoBiometricCameraController {
  dispatch_queue_t _sessionQueue;          // serial queue dedicada (NUNCA main thread)
  AVCaptureSession *_session;
  AVCaptureDeviceInput *_input;
  AVCapturePhotoOutput *_photoOutput;
  AVCaptureVideoPreviewLayer *_previewLayer;

  // iOS 17+: deriva los ángulos de rotación REALES desde el sensor (preview + capture). Tipado como
  // `id` para que la declaración del ivar sea segura en el target 13.4 (la clase es API_AVAILABLE 17);
  // todo acceso a sus propiedades va detrás de `@available(iOS 17, *)`.
  id _rotationCoordinator;

  __weak id<VeoBiometricCameraPreviewListener> _listener;

  // Captura en curso (una a la vez): callback + delegate retainer.
  void (^_pendingCapture)(NSString *_Nullable, NSString *_Nullable, NSString *_Nullable);

  // Observers de runtime de la sesión (para liberarlos en teardown).
  id _runtimeErrorObserver;
}

@synthesize state = _state;

#pragma mark - Singleton

+ (instancetype)sharedController {
  static VeoBiometricCameraController *shared = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    shared = [[VeoBiometricCameraController alloc] init];
  });
  return shared;
}

- (instancetype)init {
  if (self = [super init]) {
    _sessionQueue = dispatch_queue_create("pe.veo.driver.biometric.camera", DISPATCH_QUEUE_SERIAL);
    _state = VeoBiometricCameraStateIdle;
  }
  return self;
}

#pragma mark - Listener

- (void)setPreviewListener:(id<VeoBiometricCameraPreviewListener>)listener {
  _listener = listener;
  // Re-emitir el estado actual al registrarse (paridad con Android `setPreviewListener`).
  VeoBiometricCameraState current = self.state;
  [self notifyState:current];
}

#pragma mark - API VISTA de preview

- (AVCaptureVideoPreviewLayer *)startPreview {
  // La preview layer se crea/retorna SIEMPRE en el main thread (la consume UIKit). La configuración
  // pesada de la sesión va a la serial queue.
  if (_previewLayer == nil) {
    AVCaptureSession *session = [[AVCaptureSession alloc] init];
    // Preset ACOTADO para rostro (1280x720), con fallback a 640x480 si el device no lo soporta. NO usar
    // `AVCaptureSessionPresetPhoto` (full res → JPEG de varios MB → base64 enorme → 413). Ver doc de
    // `kVeoBiometricCapturePresetPrimary`.
    if ([session canSetSessionPreset:kVeoBiometricCapturePresetPrimary]) {
      session.sessionPreset = kVeoBiometricCapturePresetPrimary;
    } else if ([session canSetSessionPreset:kVeoBiometricCapturePresetFallback]) {
      session.sessionPreset = kVeoBiometricCapturePresetFallback;
    }
    _session = session;
    _previewLayer = [[AVCaptureVideoPreviewLayer alloc] initWithSession:session];
    _previewLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
  }

  AVAuthorizationStatus status =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  switch (status) {
    case AVAuthorizationStatusAuthorized:
      [self configureAndStart];
      break;
    case AVAuthorizationStatusNotDetermined: {
      // Pedimos permiso (AVFoundation muestra el prompt con NSCameraUsageDescription).
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                               completionHandler:^(BOOL granted) {
        if (granted) {
          [self configureAndStart];
        } else {
          [self emitError:VeoBiometricErrorPermission message:@"Permiso de cámara denegado"];
        }
      }];
      break;
    }
    case AVAuthorizationStatusDenied:
    case AVAuthorizationStatusRestricted:
    default:
      [self emitError:VeoBiometricErrorPermission message:@"Permiso de cámara denegado"];
      break;
  }
  return _previewLayer;
}

- (BOOL)isPreviewReady {
  return self.state == VeoBiometricCameraStateReady && _session != nil &&
         _session.isRunning && _photoOutput != nil;
}

- (void)stopPreview {
  dispatch_async(_sessionQueue, ^{
    [self teardownLocked];
    self->_state = VeoBiometricCameraStateIdle;
    [self notifyState:VeoBiometricCameraStateIdle];
  });
}

#pragma mark - Configuración de la sesión (serial queue)

- (void)configureAndStart {
  dispatch_async(_sessionQueue, ^{
    if (self->_session.isRunning) {
      // Ya corriendo: re-notificamos READY de forma idempotente.
      self->_state = VeoBiometricCameraStateReady;
      [self notifyState:VeoBiometricCameraStateReady];
      return;
    }

    self->_state = VeoBiometricCameraStateOpening;
    [self notifyState:VeoBiometricCameraStateOpening];

    AVCaptureDevice *device = [self frontCamera];
    if (device == nil) {
      [self emitError:VeoBiometricErrorNoFront message:@"No hay cámara frontal disponible"];
      return;
    }

    NSError *inputError = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device
                                                                       error:&inputError];
    if (input == nil) {
      [self emitError:VeoBiometricErrorConfig
              message:inputError.localizedDescription ?: @"No se pudo abrir la cámara frontal"];
      return;
    }

    AVCaptureSession *session = self->_session;
    [session beginConfiguration];

    if (![session canAddInput:input]) {
      [session commitConfiguration];
      [self emitError:VeoBiometricErrorConfig message:@"No se pudo agregar la entrada de cámara"];
      return;
    }
    [session addInput:input];
    self->_input = input;

    AVCapturePhotoOutput *photoOutput = [[AVCapturePhotoOutput alloc] init];
    if (![session canAddOutput:photoOutput]) {
      [session commitConfiguration];
      [self emitError:VeoBiometricErrorConfig message:@"No se pudo agregar la salida de foto"];
      return;
    }
    [session addOutput:photoOutput];
    self->_photoOutput = photoOutput;

    [session commitConfiguration];

    // iOS 17+: armamos el coordinator de rotación con el device frontal y la preview layer. De acá
    // salen los ángulos REALES (preview + capture), reemplazando el viejo 90° hardcodeado. El
    // coordinator se crea/observa en el main thread porque toca la preview layer (CALayer/UIKit).
    if (@available(iOS 17.0, *)) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [self setupRotationCoordinatorForDevice:device];
      });
    }

    // Observa errores de runtime del device (equivalente a CameraDevice.onError de Android).
    self->_runtimeErrorObserver =
        [[NSNotificationCenter defaultCenter] addObserverForName:AVCaptureSessionRuntimeErrorNotification
                                                          object:session
                                                           queue:nil
                                                      usingBlock:^(NSNotification *note) {
      NSError *err = note.userInfo[AVCaptureSessionErrorKey];
      [self emitError:VeoBiometricErrorDevice
              message:err.localizedDescription ?: @"Error de cámara en runtime"];
    }];

    @try {
      [session startRunning];
    } @catch (NSException *exception) {
      [self emitError:VeoBiometricErrorDevice message:exception.reason ?: @"Fallo al iniciar la cámara"];
      return;
    }

    if (session.isRunning) {
      self->_state = VeoBiometricCameraStateReady;
      [self notifyState:VeoBiometricCameraStateReady];
    } else {
      [self emitError:VeoBiometricErrorDevice message:@"La sesión de cámara no arrancó"];
    }
  });
}

- (AVCaptureDevice *)frontCamera {
  AVCaptureDeviceDiscoverySession *discovery = [AVCaptureDeviceDiscoverySession
      discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ]
                            mediaType:AVMediaTypeVideo
                             position:AVCaptureDevicePositionFront];
  return discovery.devices.firstObject;
}

#pragma mark - Rotación (coordinator iOS 17+)

// Clave KVO observada en el coordinator para refrescar el ángulo de la preview cuando el device rota.
static NSString *const kVeoPreviewAngleKeyPath = @"videoRotationAngleForHorizonLevelPreview";
static void *kVeoRotationCoordinatorContext = &kVeoRotationCoordinatorContext;

/**
 * Crea el `AVCaptureDeviceRotationCoordinator` con el device frontal y la preview layer compartida, y
 * observa el ángulo de preview por KVO. Corre en el main thread (toca la preview layer). Idempotente.
 */
- (void)setupRotationCoordinatorForDevice:(AVCaptureDevice *)device API_AVAILABLE(ios(17.0)) {
  if (_rotationCoordinator != nil) {
    [self teardownRotationCoordinator];
  }
  if (device == nil) {
    return;
  }
  AVCaptureDeviceRotationCoordinator *coordinator =
      [[AVCaptureDeviceRotationCoordinator alloc] initWithDevice:device
                                                    previewLayer:_previewLayer];
  _rotationCoordinator = coordinator;
  [coordinator addObserver:self
                forKeyPath:kVeoPreviewAngleKeyPath
                   options:NSKeyValueObservingOptionNew
                   context:kVeoRotationCoordinatorContext];

  // Empuja el ángulo inicial a la vista (la conexión de la preview layer ya puede estar lista).
  [self notifyPreviewRotationChanged];
}

- (void)teardownRotationCoordinator {
  if (_rotationCoordinator == nil) {
    return;
  }
  if (@available(iOS 17.0, *)) {
    @try {
      [_rotationCoordinator removeObserver:self
                                forKeyPath:kVeoPreviewAngleKeyPath
                                   context:kVeoRotationCoordinatorContext];
    } @catch (NSException *exception) {
      // Sin observer registrado: no-op defensivo.
    }
  }
  _rotationCoordinator = nil;
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  if (context == kVeoRotationCoordinatorContext) {
    [self notifyPreviewRotationChanged];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

/** Re-emite un evento Ready para que la vista vuelva a consultar `currentPreviewRotationAngle`. */
- (void)notifyPreviewRotationChanged {
  if (self.state == VeoBiometricCameraStateReady) {
    [self notifyState:VeoBiometricCameraStateReady];
  }
}

- (CGFloat)currentPreviewRotationAngle {
  if (@available(iOS 17.0, *)) {
    AVCaptureDeviceRotationCoordinator *coordinator = _rotationCoordinator;
    if (coordinator != nil) {
      return coordinator.videoRotationAngleForHorizonLevelPreview;
    }
    // iOS 17 pero el coordinator todavía no está armado: la vista no debe tocar el ángulo aún.
    return kVeoBiometricRotationAngleUnavailable;
  }
  // iOS < 17: fallback canónico de retrato (branch deprecado). Es seguro setearlo siempre.
  return kVeoBiometricPortraitFallbackAngle;
}

#pragma mark - API MÓDULO de captura (still sobre la sesión compartida)

- (void)capturePhotoBase64:(void (^)(NSString *_Nullable, NSString *_Nullable, NSString *_Nullable))completion {
  dispatch_async(_sessionQueue, ^{
    AVCapturePhotoOutput *output = self->_photoOutput;
    if (self->_state != VeoBiometricCameraStateReady || output == nil || !self->_session.isRunning) {
      completion(nil, VeoBiometricErrorDevice, @"La preview no está lista para capturar");
      return;
    }
    if (self->_pendingCapture != nil) {
      completion(nil, VeoBiometricErrorDevice, @"Ya hay una captura en curso");
      return;
    }
    self->_pendingCapture = [completion copy];

    AVCapturePhotoSettings *settings = [AVCapturePhotoSettings photoSettings];

    // Orientación del still: el archivo debe salir DERECHO (upright) y NO espejado, igual criterio que
    // Android (enroll y verify deben usar la misma "mano"). Forzamos `videoMirrored = NO` en la
    // conexión del photo output; la preview SÍ se espeja, pero en la vista (transform), no acá.
    AVCaptureConnection *photoConnection =
        [output connectionWithMediaType:AVMediaTypeVideo];
    if (photoConnection != nil) {
      if (photoConnection.isVideoMirroringSupported) {
        photoConnection.automaticallyAdjustsVideoMirroring = NO;
        photoConnection.videoMirrored = NO;
      }
      if (@available(iOS 17.0, *)) {
        // Ángulo REAL de captura derivado del sensor (NO el viejo 90° hardcodeado), para que el
        // archivo salga DERECHO y coherente con lo que el usuario ve en la preview. Si el coordinator
        // aún no está armado, caemos al retrato canónico como red de seguridad.
        AVCaptureDeviceRotationCoordinator *coordinator = self->_rotationCoordinator;
        CGFloat captureAngle = (coordinator != nil)
            ? coordinator.videoRotationAngleForHorizonLevelCapture
            : kVeoBiometricPortraitFallbackAngle;
        if ([photoConnection isVideoRotationAngleSupported:captureAngle]) {
          photoConnection.videoRotationAngle = captureAngle;
        }
      } else if (photoConnection.isVideoOrientationSupported) {
        photoConnection.videoOrientation = AVCaptureVideoOrientationPortrait;
      }
    }

    @try {
      [output capturePhotoWithSettings:settings delegate:self];
    } @catch (NSException *exception) {
      [self resolveCaptureWithBase64:nil
                                code:VeoBiometricErrorDevice
                             message:exception.reason ?: @"Fallo al capturar la foto"];
    }
  });
}

#pragma mark - AVCapturePhotoCaptureDelegate

- (void)captureOutput:(AVCapturePhotoOutput *)output
    didFinishProcessingPhoto:(AVCapturePhoto *)photo
                       error:(NSError *)error {
  if (error != nil) {
    [self resolveCaptureWithBase64:nil
                              code:VeoBiometricErrorDevice
                           message:error.localizedDescription ?: @"Error procesando la foto"];
    return;
  }
  NSData *jpeg = [photo fileDataRepresentation];
  if (jpeg == nil) {
    [self resolveCaptureWithBase64:nil
                              code:VeoBiometricErrorDevice
                           message:@"La captura no produjo imagen"];
    return;
  }
  NSString *base64 = [jpeg base64EncodedStringWithOptions:0];
  [self resolveCaptureWithBase64:base64 code:nil message:nil];
}

- (void)resolveCaptureWithBase64:(NSString *)base64 code:(NSString *)code message:(NSString *)message {
  // Garantiza ejecución serializada del resolve aunque el delegate llegue en otra cola.
  dispatch_async(_sessionQueue, ^{
    void (^cb)(NSString *, NSString *, NSString *) = self->_pendingCapture;
    if (cb == nil) {
      return;
    }
    self->_pendingCapture = nil;
    cb(base64, code, message);
  });
}

#pragma mark - Estado / errores

- (void)emitError:(NSString *)code message:(NSString *)message {
  _state = VeoBiometricCameraStateError;
  __weak id<VeoBiometricCameraPreviewListener> listener = _listener;
  dispatch_async(dispatch_get_main_queue(), ^{
    id<VeoBiometricCameraPreviewListener> strong = listener;
    [strong biometricCameraDidFailWithCode:code message:message];
    [strong biometricCameraDidChangeState:VeoBiometricCameraStateError];
  });
}

- (void)notifyState:(VeoBiometricCameraState)state {
  __weak id<VeoBiometricCameraPreviewListener> listener = _listener;
  dispatch_async(dispatch_get_main_queue(), ^{
    [listener biometricCameraDidChangeState:state];
  });
}

#pragma mark - Teardown (serial queue)

- (void)teardownLocked {
  // Resuelve cualquier captura colgada como fallo antes de cerrar.
  if (_pendingCapture != nil) {
    void (^cb)(NSString *, NSString *, NSString *) = _pendingCapture;
    _pendingCapture = nil;
    cb(nil, VeoBiometricErrorDevice, @"Cámara cerrada durante la captura");
  }

  if (_runtimeErrorObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_runtimeErrorObserver];
    _runtimeErrorObserver = nil;
  }

  // El coordinator y su KVO se armaron en el main thread (toca la preview layer): lo soltamos ahí.
  if (_rotationCoordinator != nil) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self teardownRotationCoordinator];
    });
  }

  if (_session != nil) {
    if (_session.isRunning) {
      [_session stopRunning];
    }
    [_session beginConfiguration];
    if (_input != nil) {
      [_session removeInput:_input];
    }
    if (_photoOutput != nil) {
      [_session removeOutput:_photoOutput];
    }
    [_session commitConfiguration];
  }
  _input = nil;
  _photoOutput = nil;
  // La preview layer y la session se conservan para un re-startPreview rápido; se sueltan en dealloc.
}

- (void)dealloc {
  if (_runtimeErrorObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_runtimeErrorObserver];
  }
  // Quita el observer KVO del coordinator de forma síncrona (estamos en dealloc; no podemos diferir).
  [self teardownRotationCoordinator];
}

@end
