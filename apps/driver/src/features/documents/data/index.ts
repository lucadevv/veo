export { HttpDocumentsRepository } from './repositories/http-documents-repository';
export { HttpDocumentUploader } from './uploaders/http-document-uploader';
export {
  NativeImagePickerService,
  nativeImagePickerService,
} from './pickers/native-image-picker-service';
export {
  NativeDocumentScanner,
  nativeDocumentScanner,
  nativeDocumentScannerLinked,
} from './services/native-document-scanner';
// `scannedImageToPickedImage`, `ocrEngineForPlatform` y `ocrTimestampNow` se movieron a
// `core/scanning/*` (capacidad transversal de escaneo/OCR) para que `registration` las reuse sin
// importar los internals (`data/`) de esta feature. Impórtalas desde `core/scanning/*`.
