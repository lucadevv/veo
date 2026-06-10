#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
// RN 0.85 — patrón del template oficial: RCTReactNativeFactory + delegate que hereda de
// RCTDefaultReactNativeFactoryDelegate, con `dependencyProvider` (codegen) que registra los
// módulos core + autolinkeados en bridgeless. Espejo del passenger.
#import <RCTDefaultReactNativeFactoryDelegate.h>
#import <RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

#pragma mark - Delegate de la factory (bundleURL + provider de dependencias)

@interface VeoDriverReactNativeFactoryDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@implementation VeoDriverReactNativeFactoryDelegate

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

@property (nonatomic, strong) VeoDriverReactNativeFactoryDelegate *reactNativeDelegate;
@property (nonatomic, strong) RCTReactNativeFactory *reactNativeFactory;

@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.reactNativeDelegate = [VeoDriverReactNativeFactoryDelegate new];
  // Provider generado por codegen: registra módulos core + autolinkeados (obligatorio en bridgeless).
  self.reactNativeDelegate.dependencyProvider = [RCTAppDependencyProvider new];
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self.reactNativeDelegate];

  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  [self.reactNativeFactory startReactNativeWithModuleName:@"VEODriver"
                                                  inWindow:self.window
                                         initialProperties:@{}
                                             launchOptions:launchOptions];

  return YES;
}

@end
