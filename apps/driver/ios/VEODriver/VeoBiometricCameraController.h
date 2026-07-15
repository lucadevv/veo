#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Códigos de error TIPADOS del subsistema de cámara biométrica. Son el CONTRATO EXACTO compartido con
 * Android (Kotlin `BiometricCameraController`) y con JS (`BiometricCameraErrorCode`). NO inventar ni
 * cambiar: llegan a JS por el evento `onCameraError` de la vista de preview.
 */
extern NSString *const VeoBiometricErrorPermission;  // E_CAMERA_PERMISSION
extern NSString *const VeoBiometricErrorNoFront;      // E_NO_FRONT_CAMERA
extern NSString *const VeoBiometricErrorConfig;       // E_CAMERA_CONFIG
extern NSString *const VeoBiometricErrorDevice;       // E_CAMERA_DEVICE

/** Estado observable de la sesión de preview (espejo del enum Android `State`). */
typedef NS_ENUM(NSInteger, VeoBiometricCameraState) {
  VeoBiometricCameraStateIdle = 0,
  VeoBiometricCameraStateOpening,
  VeoBiometricCameraStateReady,
  VeoBiometricCameraStateError,
};

/**
 * Listener de la vista de preview: recibe transiciones de estado y errores tipados, equivalente al
 * `PreviewListener` de Android. La vista lo implementa para emitir `onCameraReady` / `onCameraError`.
 */
@protocol VeoBiometricCameraPreviewListener <NSObject>
- (void)biometricCameraDidChangeState:(VeoBiometricCameraState)state;
- (void)biometricCameraDidFailWithCode:(NSString *)code message:(NSString *)message;
@end

/**
 * Controlador AVFoundation COMPARTIDO de la cámara frontal biométrica (espejo del
 * `BiometricCameraController` de Android).
 *
 * Es el dueño ÚNICO de la `AVCaptureSession` durante el KYC. Mantiene una sesión de doble salida:
 *  - la sesión alimenta la `AVCaptureVideoPreviewLayer` de la vista RN (feed en vivo), y
 *  - un `AVCapturePhotoOutput` para la captura de la foto (still) SIN abrir una segunda cámara.
 *
 * COORDINACIÓN (contrato): hay UNA instancia process-wide (`sharedController`). La vista de preview
 * gobierna el lifecycle (arranca al montarse, para al desmontarse). El módulo de captura
 * (`VeoBiometricFrameGrabber`) NO abre su propia cámara cuando hay una preview activa: pide el still
 * sobre la sesión ya abierta vía `-capturePhotoWithResolve:reject:`, manteniendo la preview viva. Si no
 * hay preview montada, el grabber cae a su captura autónoma, preservando el flujo del alta.
 *
 * Todo el trabajo de cámara corre en una serial queue dedicada (NUNCA en el main thread). Los recursos
 * (session, inputs, outputs) se liberan de forma idempotente en `-stopPreview`.
 */
@interface VeoBiometricCameraController : NSObject

/** Singleton process-wide compartido por la vista de preview y el grabber. */
+ (instancetype)sharedController;

/** Estado actual de la sesión (thread-safe lectura simple). */
@property (atomic, readonly) VeoBiometricCameraState state;

// --- API para la VISTA de preview ---

/** Registra el listener de la vista (estado/errores). Re-emite el estado actual al registrarse. */
- (void)setPreviewListener:(nullable id<VeoBiometricCameraPreviewListener>)listener;

/**
 * Arranca la preview: chequea permiso, busca la cámara frontal, configura la sesión y la corre. Si no
 * hay permiso o no hay cámara frontal, emite el error tipado al listener (NUNCA crashea). Devuelve la
 * `AVCaptureVideoPreviewLayer` ya conectada a la sesión para que la vista la monte en su `layer`.
 */
- (AVCaptureVideoPreviewLayer *)startPreview;

/** Indica si la sesión de preview está corriendo y lista para capturar sin abrir una cámara nueva. */
- (BOOL)isPreviewReady;

/**
 * Ángulo de rotación (en GRADOS) que la vista debe aplicar a la conexión de SU preview layer para que
 * el feed salga DERECHO respecto del horizonte.
 *
 * En iOS 17+ se deriva del SENSOR vía `AVCaptureDeviceRotationCoordinator`
 * (`videoRotationAngleForHorizonLevelPreview`) — NO es un número mágico. En iOS < 17 devuelve el valor
 * canónico de retrato (90°) como fallback del branch deprecado.
 *
 * Devuelve un valor < 0 si todavía no hay coordinator/preview armados (la vista NO debe tocar el ángulo
 * en ese caso). La vista vuelve a consultar este valor al recibir `biometricCameraDidChangeState:Ready`
 * y en cada `layoutSubviews`.
 */
- (CGFloat)currentPreviewRotationAngle;

/** Para la preview y libera todos los recursos. Idempotente. */
- (void)stopPreview;

// --- API para el MÓDULO de captura ---

/**
 * Dispara un still capture sobre la sesión de preview ABIERTA y devuelve el JPEG en base64 (mismo
 * contrato que el grabber). El bloque corre en background. `base64` es nil ante fallo (con `code`/`msg`).
 */
- (void)capturePhotoBase64:(void (^)(NSString *_Nullable base64,
                                     NSString *_Nullable errorCode,
                                     NSString *_Nullable errorMessage))completion;

@end

NS_ASSUME_NONNULL_END
