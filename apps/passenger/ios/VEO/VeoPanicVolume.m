//
//  VeoPanicVolume.m
//  Puente Obj-C que expone el módulo Swift `VeoPanicVolume` (RCTEventEmitter) a React Native.
//  RN descubre el módulo por `RCT_EXTERN_MODULE`; la implementación real vive en Swift.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(VeoPanicVolume, RCTEventEmitter)

// Arma la detección de la secuencia oculta (3× volumen) — secuencia de pánico (BR-S04).
RCT_EXTERN_METHOD(start)
// Detiene la detección.
RCT_EXTERN_METHOD(stop)

@end
