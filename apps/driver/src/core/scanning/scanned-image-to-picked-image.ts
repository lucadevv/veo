import type { PickedImage } from './picked-image';

/**
 * Construye un `PickedImage` a partir de una imagen base64 JPEG del escáner (croppeada + corregida por
 * el nativo, SIN prefijo `data:`). Se modela como `data:` URI para REUSAR EXACTO el pipeline de subida
 * existente (`HttpDocumentUploader` lee `file.uri` vía `fetch(uri).blob()`, que soporta `data:` en RN)
 * sin tocar el uploader. El `mimeType` explícito hace que el `contentType` se resuelva como `image/jpeg`.
 *
 * Vive en `core/scanning` (no en una feature) para que TODOS los flujos de escaneo lo compartan: el
 * sheet de documentos (licencia/SOAT/tarjeta) y el sheet del DNI (anverso + reverso) — sin duplicar la
 * conversión ni acoplar `registration` a los internals de `documents`.
 *
 * @param base64Jpeg Imagen base64 JPEG SIN prefijo `data:` (lo que entrega `ScannedDocument.images[i]`).
 * @param fileName Nombre lógico del archivo (solo para trazabilidad/derivación de extensión). Default `scan.jpg`.
 */
export function scannedImageToPickedImage(base64Jpeg: string, fileName = 'scan.jpg'): PickedImage {
  return {
    uri: `data:image/jpeg;base64,${base64Jpeg}`,
    mimeType: 'image/jpeg',
    fileName,
    width: null,
    height: null,
    fileSize: null,
  };
}
