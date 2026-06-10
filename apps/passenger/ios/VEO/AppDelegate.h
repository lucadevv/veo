#import <UIKit/UIKit.h>

// RN 0.85: patrón RCTReactNativeFactory (template oficial). RCTAppDelegate quedó DEPRECADO
// ("will be removed in a future version of React Native. Use RCTReactNativeFactory instead")
// y con él el registro de TurboModules quedaba VACÍO en bridgeless (la app moría con
// `TurboModuleRegistry.getEnforcing('DeviceInfo') could not be found`).
@interface AppDelegate : UIResponder <UIApplicationDelegate>

@property (nonatomic, strong) UIWindow *window;

@end
