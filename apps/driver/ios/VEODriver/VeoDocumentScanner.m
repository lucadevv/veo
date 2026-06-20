#import "VeoDocumentScanner.h"
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <VisionKit/VisionKit.h>
#import <Vision/Vision.h>

#pragma mark - Códigos de error tipados (CONTRATO con Android/JS)

NSString *const VeoDocumentScannerErrorCancelled = @"E_CANCELLED";
NSString *const VeoDocumentScannerErrorUnavailable = @"E_UNAVAILABLE";
NSString *const VeoDocumentScannerErrorScanFailed = @"E_SCAN_FAILED";

#pragma mark - Constantes nombradas (sin números mágicos sueltos)

/// Páginas por defecto cuando `options.maxPages` no viene o es inválido. El uso típico (foto de un
/// documento del registro) es de una sola página.
static NSInteger const kVeoDocumentScannerDefaultMaxPages = 1;
/// Tope duro de páginas: VisionKit deja escanear muchas hojas; acotamos para no devolver payloads
/// gigantes a JS por error de configuración.
static NSInteger const kVeoDocumentScannerHardPageCap = 20;
/// Calidad de compresión JPEG de cada página (0..1). 0.85 = buen balance nitidez/peso para OCR/lectura.
static CGFloat const kVeoDocumentScannerJPEGQuality = 0.85;

/// Idiomas de reconocimiento OCR (Vision `recognitionLanguages`), en orden de prioridad: español de Perú,
/// español genérico y luego inglés (documentos del registro pueden traer términos en inglés). El ORDEN
/// define qué modelo de lenguaje prima durante el procesamiento. No son números mágicos: el dominio es
/// "documentos vehiculares peruanos".
static NSArray<NSString *> *VeoDocumentScannerRecognitionLanguages(void) {
  return @[ @"es-PE", @"es", @"en" ];
}

/// Cuántos candidatos pedimos por línea reconocida: solo el mejor (`topCandidates:1`). Más candidatos no
/// aportan al auto-llenado y encarecen el copiado de strings.
static NSUInteger const kVeoDocumentScannerTopCandidates = 1;

/**
 * Módulo nativo de ESCANEO DE DOCUMENTOS sobre VisionKit (`VNDocumentCameraViewController`), 100%
 * on-device (soberano, sin SDK externo). Presenta el escáner modal de Apple — detección de bordes,
 * auto-captura, crop y corrección de perspectiva las hace el sistema — y devuelve una página JPEG en
 * base64 por hoja escaneada (croppeada + corregida), respetando `maxPages`.
 *
 * Es un VC MODAL: se presenta sobre el `rootViewController` (en el MAIN thread) y el resultado llega por
 * el `VNDocumentCameraViewControllerDelegate`. El módulo retiene la promesa hasta que el delegate
 * resuelve/rechaza UNA sola vez; se auto-retiene mientras el escáner está vivo (el delegate del VC es
 * `weak`) y se libera en el teardown, sin retain cycles.
 */
@interface VeoDocumentScanner : NSObject <RCTBridgeModule, VNDocumentCameraViewControllerDelegate>
@end

@implementation VeoDocumentScanner {
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
  NSInteger _maxPages;
  // Se auto-retiene mientras el escáner está presentado (el VC referencia al delegate como `weak`):
  // sin esto, ARC liberaría el módulo entre la llamada y el callback del delegate.
  VeoDocumentScanner *_selfRetain;
}

RCT_EXPORT_MODULE(VeoDocumentScanner)

/// Presenta UI (modal): RN debe inicializar el módulo en el main queue.
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

#pragma mark - API expuesta a JS

/**
 * Abre el escáner de documentos y resuelve con:
 *
 *   `@{ @"images": @[<base64 jpeg>, ...], @"textLines": @[ @[<líneas pág 0>], @[<líneas pág 1>], ... ] }`
 *
 *   - `images[i]`:    página escaneada (croppeada + corregida por VisionKit), base64 SIN prefijo `data:`.
 *   - `textLines[i]`: array de strings con las líneas OCR (Apple Vision, on-device) de `images[i]`, en
 *                     orden de lectura top-to-bottom. MISMO índice y largo que `images`. Si una página no
 *                     reconoce texto (o el OCR falla en esa página), `textLines[i]` es `@[]` (NUNCA null):
 *                     degradación honesta, la imagen igual viaja.
 *
 * El OCR corre SÍNCRONO sobre cada `UIImage` ya capturada (no streaming) en una cola de background, sin
 * bloquear el main thread; la promesa resuelve cuando TODAS las páginas terminaron.
 *
 * `options`:
 *   - `maxPages` (number, opcional): tope de páginas a devolver. Default 1, cap duro 20.
 *
 * Reject con códigos tipados:
 *   - E_UNAVAILABLE  → el dispositivo no soporta document scanning.
 *   - E_CANCELLED    → el usuario canceló.
 *   - E_SCAN_FAILED  → el delegate reportó un error.
 */
RCT_EXPORT_METHOD(scan:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_resolve != nil || _reject != nil) {
    reject(VeoDocumentScannerErrorScanFailed, @"Ya hay un escaneo de documento en curso", nil);
    return;
  }

  // El soporte de VisionKit depende del hardware/SDK: chequear ANTES de presentar nada.
  if (![VNDocumentCameraViewController isSupported]) {
    reject(VeoDocumentScannerErrorUnavailable,
           @"Este dispositivo no admite el escaneo de documentos", nil);
    return;
  }

  _maxPages = [self resolveMaxPagesFromOptions:options];
  _resolve = [resolve copy];
  _reject = [reject copy];

  __weak typeof(self) weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    typeof(self) strongSelf = weakSelf;
    if (strongSelf == nil) {
      return;
    }
    [strongSelf presentScanner];
  });
}

#pragma mark - Presentación (MAIN thread)

- (void)presentScanner {
  UIViewController *rootViewController = [self topmostViewController];
  if (rootViewController == nil) {
    // Sin jerarquía de vistas no hay sobre qué presentar: fallamos limpio en vez de crashear.
    [self rejectWithCode:VeoDocumentScannerErrorScanFailed
                 message:@"No hay una vista activa para presentar el escáner"];
    return;
  }

  VNDocumentCameraViewController *scanner = [[VNDocumentCameraViewController alloc] init];
  scanner.delegate = self;            // el VC lo referencia como `weak`
  _selfRetain = self;                 // nos mantenemos vivos hasta el callback del delegate
  [rootViewController presentViewController:scanner animated:YES completion:nil];
}

/// Devuelve el VC más alto en la jerarquía (siguiendo `presentedViewController`) sobre el rootVC de la
/// key window activa. Evita el warning de "presenting on a VC that is already presenting".
- (nullable UIViewController *)topmostViewController {
  UIWindow *keyWindow = [self activeKeyWindow];
  UIViewController *controller = keyWindow.rootViewController;
  while (controller.presentedViewController != nil) {
    controller = controller.presentedViewController;
  }
  return controller;
}

/// Resuelve la key window de forma robusta en iOS 13+ (multi-scene), cayendo a `keyWindow` legacy.
- (nullable UIWindow *)activeKeyWindow {
  if (@available(iOS 13.0, *)) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (scene.activationState != UISceneActivationStateForegroundActive) {
        continue;
      }
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      UIWindowScene *windowScene = (UIWindowScene *)scene;
      for (UIWindow *window in windowScene.windows) {
        if (window.isKeyWindow) {
          return window;
        }
      }
      // Fallback dentro de la escena activa si ninguna está marcada como key.
      if (windowScene.windows.firstObject != nil) {
        return windowScene.windows.firstObject;
      }
    }
  }
#if !defined(__IPHONE_13_0) || __IPHONE_OS_VERSION_MIN_REQUIRED < __IPHONE_13_0
  return UIApplication.sharedApplication.keyWindow;
#else
  return UIApplication.sharedApplication.windows.firstObject;
#endif
}

#pragma mark - VNDocumentCameraViewControllerDelegate

- (void)documentCameraViewController:(VNDocumentCameraViewController *)controller
                   didFinishWithScan:(VNDocumentCameraScan *)scan {
  // Cap a `maxPages`: si el usuario escaneó más hojas, tomamos las primeras N (en orden).
  NSUInteger total = scan.pageCount;
  NSUInteger limit = (NSUInteger)MAX((NSInteger)0, _maxPages);
  NSUInteger count = MIN(total, limit);

  // Capturamos las páginas (UIImage) en el MAIN thread — `imageOfPageAtIndex:` debe leerse acá, mientras el
  // `scan` sigue vivo. Mantenemos `images` (base64) y `pages` (UIImage para OCR) en estricto paralelo de
  // índices: para cada página que produce JPEG válido, su UIImage entra a `pages`. Así `textLines[i]`
  // corresponde 1:1 con `images[i]`.
  NSMutableArray<NSString *> *images = [NSMutableArray arrayWithCapacity:count];
  NSMutableArray<UIImage *> *pages = [NSMutableArray arrayWithCapacity:count];
  for (NSUInteger index = 0; index < count; index++) {
    UIImage *page = [scan imageOfPageAtIndex:index];
    if (page == nil) {
      continue;
    }
    NSData *jpeg = UIImageJPEGRepresentation(page, kVeoDocumentScannerJPEGQuality);
    if (jpeg == nil) {
      continue;
    }
    [images addObject:[jpeg base64EncodedStringWithOptions:0]];
    [pages addObject:page];
  }

  // El VC modal y la promesa ya no dependen del estado del módulo: copiamos lo necesario y hacemos teardown.
  // El OCR corre DESPUÉS, en background, sin tocar `self` mutable (evita carreras y retain cycles).
  RCTPromiseResolveBlock resolve = _resolve;
  [self teardown];
  [self dismissController:controller completion:^{
    if (resolve == nil) {
      return;
    }
    // OCR síncrono por página en background: no bloqueamos el main thread mientras Vision trabaja.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSArray<NSArray<NSString *> *> *textLines =
          [VeoDocumentScanner recognizeTextLinesForPages:pages];
      resolve(@{ @"images" : [images copy], @"textLines" : textLines });
    });
  }];
}

#pragma mark - OCR (Apple Vision, on-device)

/**
 * Corre OCR (`VNRecognizeTextRequest`) sobre cada página, SÍNCRONO por página, y devuelve un array de
 * arrays de líneas en estricto paralelo a `pages` (mismo índice, mismo largo). Pensado para correr OFF the
 * main thread. Si una página no reconoce texto o el request falla, su entrada es `@[]` (nunca null): la
 * página no se pierde, solo viaja sin texto.
 *
 * Es un método de clase (sin estado de instancia) para dejar EXPLÍCITO que no toca ni retiene `self`.
 */
+ (NSArray<NSArray<NSString *> *> *)recognizeTextLinesForPages:(NSArray<UIImage *> *)pages {
  NSMutableArray<NSArray<NSString *> *> *result = [NSMutableArray arrayWithCapacity:pages.count];
  for (UIImage *page in pages) {
    [result addObject:[self recognizeTextLinesForImage:page]];
  }
  return [result copy];
}

/// OCR de UNA página → líneas en orden de lectura (top-to-bottom). Degrada a `@[]` ante cualquier fallo.
+ (NSArray<NSString *> *)recognizeTextLinesForImage:(UIImage *)image {
  CGImageRef cgImage = image.CGImage;
  if (cgImage == NULL) {
    // Una `UIImage` respaldada por CIImage (no por CGImage) no la podemos pasar al handler de CGImage:
    // degradamos honesto en vez de inventar una conversión frágil.
    return @[];
  }

  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.recognitionLanguages = VeoDocumentScannerRecognitionLanguages();
  request.usesLanguageCorrection = YES;

  // La orientación EXIF de la `UIImage` (VisionKit ya corrige perspectiva, pero `imageOrientation` puede no
  // ser Up): se la pasamos al handler para que Vision lea el texto derecho.
  CGImagePropertyOrientation orientation =
      [self cgOrientationForUIImageOrientation:image.imageOrientation];
  VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithCGImage:cgImage
                                         orientation:orientation
                                             options:@{}];

  NSError *error = nil;
  BOOL ok = [handler performRequests:@[ request ] error:&error];
  if (!ok || error != nil) {
    return @[];
  }

  NSArray<VNRecognizedTextObservation *> *observations = request.results;
  if (observations.count == 0) {
    return @[];
  }

  // Vision devuelve coords normalizadas con origen abajo-izquierda: `boundingBox.origin.y` MAYOR = más
  // arriba en la hoja. Ordenamos descendente por y para garantizar lectura top-to-bottom explícita.
  NSArray<VNRecognizedTextObservation *> *sorted = [observations
      sortedArrayUsingComparator:^NSComparisonResult(VNRecognizedTextObservation *a,
                                                      VNRecognizedTextObservation *b) {
        CGFloat ya = CGRectGetMinY(a.boundingBox);
        CGFloat yb = CGRectGetMinY(b.boundingBox);
        if (ya > yb) {
          return NSOrderedAscending;  // `a` está más arriba → va primero
        }
        if (ya < yb) {
          return NSOrderedDescending;
        }
        return NSOrderedSame;
      }];

  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithCapacity:sorted.count];
  for (VNRecognizedTextObservation *observation in sorted) {
    VNRecognizedText *best = [observation topCandidates:kVeoDocumentScannerTopCandidates].firstObject;
    NSString *text = best.string;
    if (text.length > 0) {
      [lines addObject:text];
    }
  }
  return [lines copy];
}

/// Mapea `UIImageOrientation` (UIKit) → `CGImagePropertyOrientation` (EXIF) para alimentar a Vision.
+ (CGImagePropertyOrientation)cgOrientationForUIImageOrientation:(UIImageOrientation)orientation {
  switch (orientation) {
    case UIImageOrientationUp:            return kCGImagePropertyOrientationUp;
    case UIImageOrientationDown:          return kCGImagePropertyOrientationDown;
    case UIImageOrientationLeft:          return kCGImagePropertyOrientationLeft;
    case UIImageOrientationRight:         return kCGImagePropertyOrientationRight;
    case UIImageOrientationUpMirrored:    return kCGImagePropertyOrientationUpMirrored;
    case UIImageOrientationDownMirrored:  return kCGImagePropertyOrientationDownMirrored;
    case UIImageOrientationLeftMirrored:  return kCGImagePropertyOrientationLeftMirrored;
    case UIImageOrientationRightMirrored: return kCGImagePropertyOrientationRightMirrored;
  }
  return kCGImagePropertyOrientationUp;
}

- (void)documentCameraViewControllerDidCancel:(VNDocumentCameraViewController *)controller {
  [self failAndDismiss:controller
                  code:VeoDocumentScannerErrorCancelled
               message:@"El escaneo de documento fue cancelado"];
}

- (void)documentCameraViewController:(VNDocumentCameraViewController *)controller
                    didFailWithError:(NSError *)error {
  NSString *message = error.localizedDescription ?: @"Falló el escaneo del documento";
  [self failAndDismiss:controller
                  code:VeoDocumentScannerErrorScanFailed
               message:message];
}

#pragma mark - Resolución / cleanup

- (void)failAndDismiss:(VNDocumentCameraViewController *)controller
                  code:(NSString *)code
               message:(NSString *)message {
  RCTPromiseRejectBlock reject = _reject;
  [self teardown];
  [self dismissController:controller completion:^{
    if (reject != nil) {
      reject(code, message, nil);
    }
  }];
}

/// Reject sin VC vivo (caso "no hay rootVC"): no hay nada que cerrar.
- (void)rejectWithCode:(NSString *)code message:(NSString *)message {
  RCTPromiseRejectBlock reject = _reject;
  [self teardown];
  if (reject != nil) {
    reject(code, message, nil);
  }
}

- (void)dismissController:(UIViewController *)controller
               completion:(nullable void (^)(void))completion {
  if (controller == nil) {
    if (completion != nil) {
      completion();
    }
    return;
  }
  [controller dismissViewControllerAnimated:YES completion:completion];
}

/// Limpia el estado de la promesa y suelta la auto-retención. Idempotente: tras esto no se puede
/// resolver/rechazar dos veces (los punteros locales ya copiados por el caller siguen válidos).
- (void)teardown {
  _resolve = nil;
  _reject = nil;
  _maxPages = 0;
  _selfRetain = nil;
}

#pragma mark - Helpers

/// Lee `maxPages` de `options` con default y cap duro nombrados. Cualquier valor < 1 cae al default.
- (NSInteger)resolveMaxPagesFromOptions:(NSDictionary *)options {
  NSInteger requested = kVeoDocumentScannerDefaultMaxPages;
  id raw = options[@"maxPages"];
  if ([raw isKindOfClass:[NSNumber class]]) {
    NSInteger value = [(NSNumber *)raw integerValue];
    if (value >= 1) {
      requested = value;
    }
  }
  return MIN(requested, kVeoDocumentScannerHardPageCap);
}

@end
