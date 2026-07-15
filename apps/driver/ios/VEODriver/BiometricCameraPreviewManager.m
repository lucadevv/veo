#import <React/RCTViewManager.h>
#import <React/RCTComponent.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import "VeoBiometricCameraController.h"

#pragma mark - Vista nativa

/**
 * Vista nativa RN que renderiza el feed EN VIVO de la cámara frontal biométrica dentro del árbol RN
 * (espejo del `BiometricCameraPreviewView` de Android).
 *
 * Usa una `AVCaptureVideoPreviewLayer` (no un UIImageView) alimentada por la sesión COMPARTIDA del
 * `VeoBiometricCameraController`. La vista gobierna el lifecycle: arranca la preview al montarse en una
 * ventana y la detiene al desmontarse, evitando dejar la cámara frontal abierta fuera del KYC (chocaría
 * con WebRTC).
 *
 * ESPEJO: solo la PREVIEW se muestra espejada (selfie natural) vía `videoMirrored` en la conexión de la
 * preview layer. El archivo JPEG capturado por el controller sale DERECHO (no espejado).
 *
 * Eventos a JS: `onCameraReady` (sin payload) y `onCameraError` (`{ code, message }`).
 */
@interface BiometricCameraPreviewView : UIView <VeoBiometricCameraPreviewListener>
@property (nonatomic, assign) BOOL mirrored;
@property (nonatomic, copy) RCTDirectEventBlock onCameraReady;
@property (nonatomic, copy) RCTDirectEventBlock onCameraError;
@end

@implementation BiometricCameraPreviewView {
  AVCaptureVideoPreviewLayer *_previewLayer;
  BOOL _started;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    _mirrored = YES;  // default true: selfie natural (paridad con Android/JS).
    self.backgroundColor = [UIColor blackColor];
  }
  return self;
}

#pragma mark - Layout

- (void)layoutSubviews {
  [super layoutSubviews];
  // La preview layer llena los bounds de la vista RN.
  _previewLayer.frame = self.bounds;
  // Reafirma la rotación en cada layout (p. ej. tras rotar el device): el ángulo lo dicta el sensor
  // vía el coordinator del controller, no un valor fijo de esta vista.
  [self applyRotation];
}

#pragma mark - Lifecycle (montaje / desmontaje)

- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (self.window != nil) {
    [self startIfNeeded];
  } else {
    // Se desmontó (removeFromSuperview / cambio de pantalla): liberar la cámara frontal.
    [self stop];
  }
}

- (void)startIfNeeded {
  if (_started) {
    return;
  }
  _started = YES;
  VeoBiometricCameraController *controller = [VeoBiometricCameraController sharedController];
  [controller setPreviewListener:self];
  AVCaptureVideoPreviewLayer *layer = [controller startPreview];
  if (layer != nil && layer != _previewLayer) {
    _previewLayer = layer;
    _previewLayer.frame = self.bounds;
    [self.layer addSublayer:_previewLayer];
  }
  [self applyMirror];
  [self applyRotation];
}

- (void)stop {
  if (!_started) {
    return;
  }
  _started = NO;
  VeoBiometricCameraController *controller = [VeoBiometricCameraController sharedController];
  [controller setPreviewListener:nil];
  [controller stopPreview];
  [_previewLayer removeFromSuperlayer];
  _previewLayer = nil;
}

- (void)dealloc {
  [self stop];
}

#pragma mark - Props

- (void)setMirrored:(BOOL)mirrored {
  _mirrored = mirrored;
  [self applyMirror];
}

/**
 * Espeja SOLO la preview en vivo (selfie natural) sin afectar el archivo capturado. Se aplica sobre la
 * conexión de la preview layer (`videoMirrored`), que es el camino correcto en AVFoundation.
 */
- (void)applyMirror {
  AVCaptureConnection *connection = _previewLayer.connection;
  if (connection == nil) {
    return;
  }
  if (connection.isVideoMirroringSupported) {
    connection.automaticallyAdjustsVideoMirroring = NO;
    connection.videoMirrored = _mirrored;
  }
}

/**
 * Orienta la preview usando el ángulo REAL del sensor.
 *
 * En iOS 17+ el ángulo lo provee el `AVCaptureDeviceRotationCoordinator` del controller
 * (`currentPreviewRotationAngle`) — NO el viejo 90° hardcodeado, que salía rotado en la frontal. En
 * iOS < 17 el controller devuelve el retrato canónico (90°) y acá usamos la API deprecada
 * `videoOrientation = Portrait`, que es el camino válido en ese branch.
 */
- (void)applyRotation {
  AVCaptureConnection *connection = _previewLayer.connection;
  if (connection == nil) {
    return;
  }
  if (@available(iOS 17.0, *)) {
    CGFloat angle = [[VeoBiometricCameraController sharedController] currentPreviewRotationAngle];
    if (angle < 0.0) {
      // Coordinator aún no armado: no tocamos el ángulo (evita un valor transitorio equivocado).
      return;
    }
    if ([connection isVideoRotationAngleSupported:angle]) {
      connection.videoRotationAngle = angle;
    }
  } else if (connection.isVideoOrientationSupported) {
    connection.videoOrientation = AVCaptureVideoOrientationPortrait;
  }
}

#pragma mark - VeoBiometricCameraPreviewListener (llega en main thread)

- (void)biometricCameraDidChangeState:(VeoBiometricCameraState)state {
  if (state == VeoBiometricCameraStateReady) {
    // Al estar lista la sesión, la conexión de la preview layer ya existe: aplicamos espejo/rotación.
    // El controller re-emite Ready cuando el coordinator detecta una rotación del device (KVO), así
    // que esto también refresca el ángulo de la preview en caliente.
    [self applyMirror];
    [self applyRotation];
    if (self.onCameraReady) {
      self.onCameraReady(@{});
    }
  }
}

- (void)biometricCameraDidFailWithCode:(NSString *)code message:(NSString *)message {
  if (self.onCameraError) {
    self.onCameraError(@{ @"code": code ?: @"", @"message": message ?: @"" });
  }
}

@end

#pragma mark - ViewManager

/**
 * ViewManager LEGACY (`RCTViewManager`) de la vista de preview biométrica.
 *
 * El proyecto tiene la New Architecture activada (`newArchEnabled=true`), pero los componentes nativos
 * propios se registran como vistas LEGACY y RN 0.85.3 los puentea automáticamente a Fabric vía su capa
 * de interop (`useFabricInterop` por defecto en true). Mismo enfoque que Android (SimpleViewManager).
 *
 * Contrato para JS (IDÉNTICO a Android):
 *  - Componente nativo: `BiometricCameraPreview` (consumir con `requireNativeComponent`).
 *  - Prop `mirrored: boolean` (default true) — espeja SOLO la preview, no el archivo.
 *  - Eventos: `onCameraReady` (sin payload), `onCameraError` ({ code, message }).
 *  - Captura: se dispara desde `VeoBiometricFrameGrabber.capturePhoto()`, que reusa la sesión de preview
 *    abierta cuando esta vista está montada.
 */
@interface BiometricCameraPreviewManager : RCTViewManager
@end

@implementation BiometricCameraPreviewManager

RCT_EXPORT_MODULE(BiometricCameraPreview)

+ (BOOL)requiresMainQueueSetup {
  return YES;  // crea UIView → debe inicializarse en el main thread.
}

- (UIView *)view {
  return [[BiometricCameraPreviewView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(mirrored, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onCameraReady, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onCameraError, RCTDirectEventBlock)

@end
