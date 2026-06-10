#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
// RN 0.85 — patrón del template oficial: RCTReactNativeFactory + un delegate que hereda de
// RCTDefaultReactNativeFactoryDelegate, con `dependencyProvider` (generado por codegen) que
// registra los módulos core + autolinkeados en bridgeless. El viejo RCTAppDelegate está
// deprecado y dejaba el registro de TurboModules VACÍO → crash al arrancar con
// `TurboModuleRegistry.getEnforcing('DeviceInfo') could not be found`.
#import <RCTDefaultReactNativeFactoryDelegate.h>
#import <RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// Firebase: se importa solo si el pod está instalado. La configuración se ejecuta
// únicamente si existe GoogleService-Info.plist en el bundle, evitando crashes
// cuando aún no hay credenciales reales.
#if __has_include(<FirebaseCore/FirebaseCore.h>)
#import <FirebaseCore/FirebaseCore.h>
#define VEO_FIREBASE_AVAILABLE 1
#endif

#pragma mark - Delegate de la factory (bundleURL + provider de dependencias)

@interface VeoReactNativeFactoryDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@implementation VeoReactNativeFactoryDelegate

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end

#pragma mark - AppDelegate

@interface AppDelegate ()

@property (nonatomic, strong) VeoReactNativeFactoryDelegate *reactNativeDelegate;
@property (nonatomic, strong) RCTReactNativeFactory *reactNativeFactory;

@end

@implementation AppDelegate

#ifdef VEO_FIREBASE_AVAILABLE
/**
 * Indica si el GoogleService-Info.plist contiene credenciales REALES (no placeholders).
 * Evita el crash de [FIRApp configure] cuando solo hay credenciales de relleno en dev:
 * Firebase valida el formato de la API_KEY y lanza una excepción si es inválida.
 */
static BOOL VeoHasRealFirebaseCredentials(void)
{
  NSString *path = [[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"];
  if (path == nil) {
    return NO;
  }
  NSDictionary *options = [NSDictionary dictionaryWithContentsOfFile:path];
  NSString *apiKey = options[@"API_KEY"];
  NSString *projectId = options[@"PROJECT_ID"];
  if (apiKey.length == 0 || projectId.length == 0) {
    return NO;
  }
  // Marcadores de relleno usados en dev (ver GoogleService-Info.plist placeholder).
  NSArray<NSString *> *placeholders = @[ @"DUMMY", @"PLACEHOLDER", @"placeholder", @"REPLACE", @"0000000000" ];
  for (NSString *marker in placeholders) {
    if ([apiKey containsString:marker] || [projectId containsString:marker]) {
      return NO;
    }
  }
  return YES;
}
#endif

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
#ifdef VEO_FIREBASE_AVAILABLE
  // Solo inicializamos Firebase con credenciales reales (push habilitado en prod/staging).
  // Con el placeholder de dev se omite para no abortar el arranque.
  if (VeoHasRealFirebaseCredentials()) {
    [FIRApp configure];
  }
#endif

  self.reactNativeDelegate = [VeoReactNativeFactoryDelegate new];
  // Provider generado por codegen: registra módulos core + autolinkeados (obligatorio en bridgeless).
  self.reactNativeDelegate.dependencyProvider = [RCTAppDependencyProvider new];
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self.reactNativeDelegate];

  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  [self.reactNativeFactory startReactNativeWithModuleName:@"VEO"
                                                  inWindow:self.window
                                         initialProperties:@{}
                                             launchOptions:launchOptions];

  return YES;
}

@end
