//
//  VeoKycFrameGrabber.m
//  Puente Obj-C que expone el módulo Swift `VeoKycFrameGrabber` a React Native.
//  RN descubre el módulo por `RCT_EXTERN_MODULE`; la implementación real vive en Swift.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(VeoKycFrameGrabber, NSObject)

// Captura `frameCount` JPEG (base64) de la cámara frontal con `intervalMs` entre frames.
RCT_EXTERN_METHOD(captureFrames:(nonnull NSNumber *)frameCount
                  intervalMs:(nonnull NSNumber *)intervalMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
