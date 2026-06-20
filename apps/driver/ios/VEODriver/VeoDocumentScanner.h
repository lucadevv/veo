#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Códigos de error TIPADOS del módulo de escaneo de documentos. Son el CONTRATO EXACTO compartido con
 * Android y con JS (`DocumentScannerErrorCode`). NO inventar ni cambiar: llegan a JS como el `code` del
 * reject de la promesa de `scan(...)`.
 *
 *  - VeoDocumentScannerErrorCancelled   → E_CANCELLED      (el usuario cerró/canceló el escáner)
 *  - VeoDocumentScannerErrorUnavailable → E_UNAVAILABLE    (el hardware no soporta document scanning)
 *  - VeoDocumentScannerErrorScanFailed  → E_SCAN_FAILED    (el delegate reportó un error de escaneo)
 */
extern NSString *const VeoDocumentScannerErrorCancelled;
extern NSString *const VeoDocumentScannerErrorUnavailable;
extern NSString *const VeoDocumentScannerErrorScanFailed;

NS_ASSUME_NONNULL_END
