package com.veodriver.scanner

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicInteger

/**
 * Módulo nativo de ESCANEO DE DOCUMENTOS sobre MLKit Document Scanner (on-device, soberano, gratis).
 *
 * Entrega detección de bordes + auto-captura + crop + corrección de perspectiva vía la UI nativa de
 * Google Play Services (`com.google.android.gms:play-services-mlkit-document-scanner`). NO procesa la
 * imagen en servidor: todo ocurre on-device, y el conductor solo entrega los JPEG ya rectificados.
 *
 * Contrato EXACTO (idéntico a iOS y JS):
 *  - `scan(options, promise)` con `options.maxPages` (int).
 *  - Resolve: `{ images: [<base64 jpeg sin prefijo data:>, ...], textLines: [[<líneas pág 0>], ...] }`.
 *    `images[i]` = un base64 por página, en orden. `textLines[i]` = WritableArray de strings (líneas OCR
 *    de la página `i`, MISMO índice/orden que `images`); página sin texto → array vacío (nunca null).
 *  - Reject tipado: [ERR_CANCELLED] / [ERR_UNAVAILABLE] / [ERR_SCAN_FAILED], mensajes en español.
 *
 * OCR on-device aditivo: tras decodificar el bitmap de cada página (el mismo que ya se usa para el JPEG
 * base64), se corre MLKit Text Recognition v2 (escritura latina, `com.google.mlkit:text-recognition`).
 * Cada `recognizer.process(image)` devuelve un `Task<Text>` ASÍNCRONO; se cuentan los Task completados con
 * un [AtomicInteger] y la promesa se resuelve UNA sola vez cuando TODAS las páginas terminaron. Si el OCR de
 * una página falla, esa página queda con `textLines` vacío pero su imagen igual se entrega (no aborta el
 * escaneo completo).
 *
 * El flujo de result se maneja con el [ActivityEventListener] de RN: `getStartScanIntent` devuelve un
 * `IntentSender` (vía Task) que se lanza con `startIntentSenderForResult` y un requestCode propio
 * ([REQUEST_CODE_SCAN]); la respuesta vuelve por [onActivityResult]. La promesa se resuelve UNA sola vez.
 */
class VeoDocumentScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  /** Promesa de la llamada `scan(...)` en curso. Null cuando no hay escaneo activo. */
  private var pendingPromise: Promise? = null

  private val activityEventListener: ActivityEventListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(
        activity: Activity?,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
      ) {
        if (requestCode != REQUEST_CODE_SCAN) return
        handleScanResult(resultCode, data)
      }
    }

  init {
    reactContext.addActivityEventListener(activityEventListener)
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    reactApplicationContext.removeActivityEventListener(activityEventListener)
  }

  /**
   * Abre el escáner nativo de documentos. `options.maxPages` limita las páginas ([setPageLimit]); si
   * falta o es inválido cae a [DEFAULT_MAX_PAGES]. La galería de importación queda habilitada para que el
   * conductor pueda elegir una foto ya tomada si lo necesita.
   */
  @ReactMethod
  fun scan(options: ReadableMap, promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject(ERR_UNAVAILABLE, "No hay actividad activa para abrir el escáner de documentos")
      return
    }
    if (pendingPromise != null) {
      promise.reject(ERR_SCAN_FAILED, "Ya hay un escaneo de documentos en curso")
      return
    }

    val maxPages =
      if (options.hasKey(KEY_MAX_PAGES)) {
        options.getInt(KEY_MAX_PAGES).coerceIn(1, MAX_PAGES_LIMIT)
      } else {
        DEFAULT_MAX_PAGES
      }

    val scannerOptions =
      GmsDocumentScannerOptions.Builder()
        .setGalleryImportAllowed(true)
        .setPageLimit(maxPages)
        .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
        .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
        .build()

    pendingPromise = promise

    GmsDocumentScanning.getClient(scannerOptions)
      .getStartScanIntent(activity)
      .addOnSuccessListener { intentSender ->
        try {
          activity.startIntentSenderForResult(
            intentSender,
            REQUEST_CODE_SCAN,
            null,
            0,
            0,
            0,
          )
        } catch (error: Throwable) {
          rejectPending(ERR_SCAN_FAILED, "No se pudo abrir el escáner de documentos", error)
        }
      }
      .addOnFailureListener { error ->
        // El cliente no pudo producir el intent: típicamente Play Services / el módulo de scanner no
        // está disponible o actualizado en este dispositivo.
        rejectPending(
          ERR_UNAVAILABLE,
          "El escáner de documentos no está disponible en este dispositivo",
          error,
        )
      }
  }

  /** Traduce el `resultCode` + data en resolve/reject tipado, liberando la promesa pendiente. */
  private fun handleScanResult(resultCode: Int, data: Intent?) {
    when (resultCode) {
      Activity.RESULT_OK -> {
        val result = GmsDocumentScanningResult.fromActivityResultIntent(data)
        if (result == null) {
          rejectPending(ERR_SCAN_FAILED, "El escáner no devolvió ningún resultado", null)
          return
        }
        try {
          val pages = decodePages(result)
          if (pages.isEmpty()) {
            rejectPending(ERR_SCAN_FAILED, "El escaneo no produjo ninguna página", null)
            return
          }
          recognizeAndResolve(pages)
        } catch (error: Throwable) {
          rejectPending(ERR_SCAN_FAILED, "No se pudieron leer las páginas escaneadas", error)
        }
      }

      Activity.RESULT_CANCELED ->
        rejectPending(ERR_CANCELLED, "El usuario canceló el escaneo de documentos", null)

      else ->
        rejectPending(ERR_SCAN_FAILED, "El escaneo de documentos falló (código $resultCode)", null)
    }
  }

  /** Una página decodificada: su JPEG ya codificado en base64 + el bitmap vivo para alimentar el OCR. */
  private data class DecodedPage(val base64: String, val bitmap: Bitmap)

  /**
   * Recorre las páginas del resultado, abre cada URI vía `contentResolver`, decodifica el bitmap, lo
   * recomprime a JPEG ([JPEG_QUALITY]) y lo codifica en base64 (sin prefijo `data:`), preservando el
   * orden. Los streams se liberan con `use {}`. A diferencia de la versión previa, el bitmap NO se recicla
   * aquí: queda vivo para que [recognizeAndResolve] le corra MLKit Text Recognition; el reciclado ocurre
   * cuando el `Task` de OCR de esa página termina.
   */
  private fun decodePages(result: GmsDocumentScanningResult): List<DecodedPage> {
    val resolver = reactApplicationContext.contentResolver
    return result.pages.orEmpty().map { page ->
      val uri: Uri = page.imageUri
      val bitmap =
        resolver.openInputStream(uri).use { stream ->
          BitmapFactory.decodeStream(stream)
        } ?: throw IllegalStateException("No se pudo decodificar la página: $uri")
      val base64 =
        ByteArrayOutputStream().use { output ->
          bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)
          Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        }
      DecodedPage(base64, bitmap)
    }
  }

  /**
   * Corre MLKit Text Recognition (escritura latina, on-device) sobre cada bitmap de página y resuelve la
   * promesa con `{ images, textLines }` una vez que TODAS las páginas terminaron.
   *
   * Concurrencia: cada `recognizer.process(...)` devuelve un `Task<Text>` asíncrono. Pre-asignamos los
   * arrays de líneas por índice (`lineSlots`), de modo que cada callback escribe SIEMPRE en su posición —
   * los resultados quedan alineados con `images` sin depender del orden de finalización de los Task. Un
   * [AtomicInteger] cuenta las páginas pendientes; sólo el callback que lo lleva a 0 dispara el resolve, así
   * la promesa se cumple una sola vez y nunca antes de tener todas las páginas. El reciclado del bitmap y el
   * cierre del recognizer (`close()`) se hacen por página al completar su Task (éxito o error), liberando
   * recursos en cuanto dejan de usarse.
   */
  private fun recognizeAndResolve(pages: List<DecodedPage>) {
    val pageCount = pages.size
    // Slots pre-asignados por índice → alineación imágenes↔textLines independiente del orden de los Task.
    val lineSlots: Array<List<String>?> = arrayOfNulls(pageCount)
    val pending = AtomicInteger(pageCount)

    val finishPage = { index: Int, lines: List<String>, bitmap: Bitmap ->
      lineSlots[index] = lines
      bitmap.recycle()
      if (pending.decrementAndGet() == 0) {
        resolveWithPages(pages, lineSlots)
      }
    }

    pages.forEachIndexed { index, page ->
      val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      val image = InputImage.fromBitmap(page.bitmap, ROTATION_DEGREES_NONE)
      recognizer
        .process(image)
        .addOnSuccessListener { text ->
          val lines = text.textBlocks.flatMap { block -> block.lines.map { it.text } }
          finishPage(index, lines, page.bitmap)
        }
        .addOnFailureListener {
          // OCR de ESTA página falló: líneas vacías, pero su imagen igual se entrega. No aborta el escaneo.
          finishPage(index, emptyList(), page.bitmap)
        }
        .addOnCompleteListener { recognizer.close() }
    }
  }

  /** Construye el payload `{ images, textLines }` alineado por índice y resuelve la promesa pendiente. */
  private fun resolveWithPages(pages: List<DecodedPage>, lineSlots: Array<List<String>?>) {
    val images: WritableArray = Arguments.createArray()
    val textLines: WritableArray = Arguments.createArray()
    pages.forEachIndexed { index, page ->
      images.pushString(page.base64)
      val pageLines: WritableArray = Arguments.createArray()
      lineSlots[index].orEmpty().forEach { pageLines.pushString(it) }
      textLines.pushArray(pageLines)
    }
    val payload: WritableMap = Arguments.createMap()
    payload.putArray(KEY_IMAGES, images)
    payload.putArray(KEY_TEXT_LINES, textLines)
    resolvePending(payload)
  }

  /** Resuelve la promesa pendiente UNA sola vez y la limpia. */
  private fun resolvePending(payload: WritableMap) {
    val promise = pendingPromise ?: return
    pendingPromise = null
    promise.resolve(payload)
  }

  /** Rechaza la promesa pendiente UNA sola vez (con causa opcional) y la limpia. */
  private fun rejectPending(code: String, message: String, cause: Throwable?) {
    val promise = pendingPromise ?: return
    pendingPromise = null
    if (cause != null) {
      promise.reject(code, message, cause)
    } else {
      promise.reject(code, message)
    }
  }

  companion object {
    const val NAME = "VeoDocumentScanner"

    // Códigos de error TIPADOS: CONTRATO EXACTO compartido con iOS (VeoDocumentScanner.h) y JS.
    private const val ERR_CANCELLED = "E_CANCELLED"
    private const val ERR_UNAVAILABLE = "E_UNAVAILABLE"
    private const val ERR_SCAN_FAILED = "E_SCAN_FAILED"

    // Claves del contrato JS.
    private const val KEY_MAX_PAGES = "maxPages"
    private const val KEY_IMAGES = "images"
    private const val KEY_TEXT_LINES = "textLines"

    // requestCode propio del módulo para startIntentSenderForResult / onActivityResult.
    private const val REQUEST_CODE_SCAN = 0x5CA4 // "SCAN"

    private const val DEFAULT_MAX_PAGES = 5
    private const val MAX_PAGES_LIMIT = 30
    private const val JPEG_QUALITY = 85

    // Las páginas del doc scanner ya vienen rectificadas (perspectiva corregida, derechas): el bitmap NO
    // necesita rotación, así que InputImage.fromBitmap recibe 0 grados.
    private const val ROTATION_DEGREES_NONE = 0
  }
}
