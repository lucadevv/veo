/**
 * Sesión/onboarding del conductor.
 *  - Comandos (onboard, shift start/end/pause) → REST interno firmado a identity-service.
 *  - GET /drivers/me → agrega lecturas gRPC de identity + rating + fleet.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError, NotFoundError, uuidv7 } from '@veo/utils';
import { createLogger, type Logger } from '@veo/observability';
import {
  DocumentSide,
  type ExtractedDocumentData,
  type FleetDocumentType,
} from '@veo/shared-types';
import type { AuthenticatedUser } from '@veo/auth';
import type { Env } from '../config/env.schema';
import type {
  DriverBiometricChallenge,
  DriverBiometricEnrollResult,
  DriverBiometricVerifyResult,
  DriverResubmitResult,
  DriverShiftStartResult,
  DriverShiftStateView,
  DriverShiftStatusResult,
} from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import { ActiveVehicleTypeResolver } from '../realtime/active-vehicle-type.resolver';
import type {
  AggregateReply,
  DriverDocumentsReply,
  DriverReply,
  DriverVehiclesReply,
  FleetDocumentReply,
  UserReply,
} from '../common/grpc-replies';
import {
  buildDriverDocument,
  buildDriverDocuments,
  buildDriverModelRequest,
  buildDriverProfile,
  buildDriverVehicleFromRest,
  buildDriverVehicleModels,
  buildDriverVehicles,
  type DriverDocumentDetailWithKeys,
  type FleetDriverVehicleReply,
  type FleetVehicleModelPageReply,
  type FleetVehicleModelRequestReply,
} from './drivers.mapper';
import {
  DOCUMENT_EXTENSION_BY_CONTENT_TYPE,
  type CheckDniDto,
  type DocumentUploadContentType,
  type DocumentUploadSideTicket,
  type DocumentUploadTicketView,
} from './dto/drivers.dto';
import type {
  DriverDniCheckResult,
  DriverDocumentDetail,
  DriverModelRequestView,
  DriverPersonalData,
  DriverProfileView,
  DriverVehicleModelView,
  DriverVehicleView,
  EnrollFaceDto,
  ListVehicleModelsQuery,
  OnboardDto,
  RegisterVehicleDto,
  RequestVehicleModelDto,
  StartShiftDto,
  UpdateDriverPersonalDto,
  VerifyBiometricDto,
} from './dto/drivers.dto';

/**
 * Página amplia del catálogo: hoy es chico (decenas de modelos) y entra en una tirada; la app no pagina.
 * Si alguna vez supera este tope para un filtro, la lista se TRUNCA — `listVehicleModels` lo loguea
 * (no silencioso) y el conductor puede acotar con `q`. Si se vuelve recurrente, paginar en la UI.
 */
const VEHICLE_MODELS_PAGE_LIMIT = 100;

/**
 * TTL (segundos) de la presigned GET con la que el conductor RE-RENDERIZA sus propias caras de documento
 * en el resume del onboarding. Corto a propósito (mismo valor que el admin review): la URL vive lo justo
 * para pintar el preview, no para cachearse. La firma es server-to-server y FAIL-SOFT.
 */
const DOCUMENT_READ_TTL_SECONDS = 120;

/** Respuesta de media-service POST /media/internal/presign-put. */
interface MediaPresignPutReply {
  url: string;
  requiredHeaders: Record<string, string>;
}

@Injectable()
export class DriversService {
  private readonly logger: Logger = createLogger('driver-bff:drivers');
  private readonly documentsBucket: string;
  private readonly documentUploadTtl: number;

  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
    private readonly activeVehicleType: ActiveVehicleTypeResolver,
    config: ConfigService<Env, true>,
  ) {
    this.documentsBucket = config.getOrThrow<string>('S3_BUCKET_DOCUMENTS');
    this.documentUploadTtl = config.getOrThrow<number>('DOCUMENT_UPLOAD_TTL_SECONDS');
  }

  onboard(identity: AuthenticatedUser, dto: OnboardDto): Promise<unknown> {
    return this.identity().post('/drivers/onboard', { identity, body: dto });
  }

  /**
   * Reenvío a revisión tras un rechazo (resubmit) → identity-service por REST interno firmado. El
   * conductor RECHAZADO corrigió sus datos en la app y vuelve a la cola de aprobación (REJECTED →
   * PENDING). identity valida la transición con sus máquinas (un conductor no-rechazado obtiene 409).
   */
  resubmit(identity: AuthenticatedUser): Promise<DriverResubmitResult> {
    return this.identity().post<DriverResubmitResult>('/drivers/me/resubmit', {
      identity,
      body: {},
    });
  }

  /**
   * Actualiza los datos personales del conductor (PII) → identity-service por REST interno firmado.
   * La PII (nombre legal, DNI, fecha de nacimiento) NO viaja por gRPC. identity devuelve el mismo shape.
   */
  updatePersonal(
    identity: AuthenticatedUser,
    dto: UpdateDriverPersonalDto,
  ): Promise<DriverPersonalData> {
    return this.identity().patch<DriverPersonalData>('/drivers/me/personal', {
      identity,
      body: dto,
    });
  }

  /**
   * Chequea si el DNI escaneado ya está registrado en OTRA cuenta de conductor (blind index `dni_hash`)
   * → identity-service por REST interno firmado. Se corre ANTES de completar el alta (F0: escaneo del
   * DNI), así el conductor recibe el aviso apenas escanea, sin esperar a enviar el formulario completo.
   */
  checkDni(identity: AuthenticatedUser, dto: CheckDniDto): Promise<DriverDniCheckResult> {
    return this.identity().post<DriverDniCheckResult>('/drivers/check-dni', {
      identity,
      body: dto,
    });
  }

  /**
   * Alta self-service del vehículo del conductor (onboarding) → fleet por REST interno firmado.
   * fleet resuelve el driverId desde la identidad propagada; el cliente no lo envía. Queda pendiente
   * de verificación (status=PENDING_REVIEW) hasta la aprobación del operador.
   */
  async registerVehicle(
    identity: AuthenticatedUser,
    dto: RegisterVehicleDto,
  ): Promise<DriverVehicleView> {
    const created = await this.rest
      .client('fleet')
      .post<FleetDriverVehicleReply>('/drivers/vehicles', { identity, body: dto });
    return buildDriverVehicleFromRest(created);
  }

  /**
   * Catálogo curado de modelos APROBADOS para el selector del onboarding (B5-2) → fleet por REST interno.
   * El conductor elige de acá en vez de tipear marca/modelo libre. Filtros opcionales: vehicleType, q.
   */
  async listVehicleModels(
    identity: AuthenticatedUser,
    query: ListVehicleModelsQuery,
  ): Promise<DriverVehicleModelView[]> {
    const page = await this.rest
      .client('fleet')
      .get<FleetVehicleModelPageReply>('/vehicle-models', {
        identity,
        query: { vehicleType: query.vehicleType, q: query.q, limit: VEHICLE_MODELS_PAGE_LIMIT },
      });
    // Truncación NO silenciosa: si fleet devuelve nextCursor, hay más modelos que el tope de una página.
    // Hoy el catálogo es chico y no debería pasar; si pasa, es señal de que la app necesita paginar/buscar.
    if (page.nextCursor) {
      this.logger.warn(
        { vehicleType: query.vehicleType, q: query.q, limit: VEHICLE_MODELS_PAGE_LIMIT },
        'catálogo de modelos truncado: hay más de una página; el selector solo verá los primeros (usar q o paginar)',
      );
    }
    return buildDriverVehicleModels(page);
  }

  /**
   * El conductor SOLICITA un modelo que no está en el catálogo (B5-2.c) → fleet POST /vehicle-models.
   * fleet resuelve el requestedBy desde la identidad propagada; queda PENDING_REVIEW hasta que el operador
   * lo apruebe completando la ficha técnica. El conductor solo recibe la confirmación.
   */
  async requestVehicleModel(
    identity: AuthenticatedUser,
    dto: RequestVehicleModelDto,
  ): Promise<DriverModelRequestView> {
    const created = await this.rest
      .client('fleet')
      .post<FleetVehicleModelRequestReply>('/vehicle-models', { identity, body: dto });
    return buildDriverModelRequest(created);
  }

  /**
   * Vehículos del conductor autenticado (rehidratación) → fleet por gRPC GetDriverVehicles.
   * El driverId que fleet guarda en el vehículo es el userId de identity, así que se consulta con él
   * directamente (sin resolver el perfil de conductor).
   */
  async getVehicles(identity: AuthenticatedUser): Promise<DriverVehicleView[]> {
    const reply = await this.grpc.call<DriverVehiclesReply>(
      'fleet',
      'GetDriverVehicles',
      { id: identity.userId },
      identity,
    );
    return buildDriverVehicles(reply.vehicles ?? []);
  }

  /**
   * Vehículo ACTIVO (operado) del conductor → fleet por REST. `null` si no tiene ninguno operable
   * (fleet responde 204). Lo usa la app para marcar cuál vehículo está activo en el selector de turno.
   */
  async getActiveVehicle(identity: AuthenticatedUser): Promise<DriverVehicleView | null> {
    const active = await this.rest
      .client('fleet')
      .get<FleetDriverVehicleReply | undefined>('/drivers/vehicles/active', { identity });
    return active ? buildDriverVehicleFromRest(active) : null;
  }

  /** Selecciona el vehículo ACTIVO del conductor → fleet por REST (server-authoritative del tipo). */
  async setActiveVehicle(
    identity: AuthenticatedUser,
    vehicleId: string,
  ): Promise<DriverVehicleView> {
    const updated = await this.rest
      .client('fleet')
      .patch<FleetDriverVehicleReply>('/drivers/vehicles/active', {
        identity,
        body: { vehicleId },
      });
    // ADR-017 §5(d) d.2: cerrar la ventana stale del ping. El resolver del tipo/attrs del vehículo activo
    // cachea por userId con TTL corto; sin esta invalidación el swap recién se reflejaría en el ping al
    // vencer el TTL. Se invalida SOLO en éxito (si el PATCH lanza, este código no corre). Es una operación
    // local sincrónica e idempotente (Map.delete), no un I/O best-effort: no puede fallar ni romper el swap.
    this.activeVehicleType.invalidate(identity.userId);
    return buildDriverVehicleFromRest(updated);
  }

  /**
   * Enrolamiento facial de referencia con UNA selfie (liveness PASIVO en identity/biometric) → identity-service.
   * F5: ANTES de enrolar, sube la selfie a MinIO (best-effort) para la AYUDA VISUAL del operador en casos
   * dudosos. Es ADICIONAL — si la subida falla, el enrol sigue igual (el embedding + el match son la
   * verificación real). identity solo REFERENCIA la key (`faceSelfieKey`) si el enrol resulta VIVO; un spoof
   * deja el blob huérfano en MinIO (se sobreescribe al próximo enrol contra la MISMA key, o se purga por
   * derecho al olvido — `drivers/{driverId}/` se barre en `user.deleted`).
   */
  async enrollFace(
    identity: AuthenticatedUser,
    dto: EnrollFaceDto,
  ): Promise<DriverBiometricEnrollResult> {
    const selfieKey = await this.tryStoreEnrollSelfie(identity, dto.photo);
    return this.identity().post<DriverBiometricEnrollResult>('/drivers/biometric/enroll', {
      identity,
      body: selfieKey ? { photo: dto.photo, selfieKey } : { photo: dto.photo },
    });
  }

  /**
   * Sube la selfie del enrol a MinIO (server-to-server, key DRIVER-SCOPED `drivers/{driverId}/kyc-selfie.jpg`,
   * misma frontera/bucket que los documentos). BEST-EFFORT: cualquier fallo (driver no resuelto, presign,
   * PUT) devuelve `null` y el enrol procede SIN selfie — nunca traba el alta por una ayuda visual. Devuelve la
   * key (que identity validará por prefijo y guardará solo en el enrol vivo) o `null`.
   */
  private async tryStoreEnrollSelfie(
    identity: AuthenticatedUser,
    photoBase64: string,
  ): Promise<string | null> {
    try {
      const driver = await this.grpc.call<DriverReply>(
        'identity',
        'GetDriverByUser',
        { id: identity.userId },
        identity,
      );
      if (!driver.found) return null;
      const key = `drivers/${driver.id}/kyc-selfie.jpg`;
      const ticket = await this.rest.client('media').post<MediaPresignPutReply>(
        '/media/internal/presign-put',
        {
          identity,
          body: {
            bucket: this.documentsBucket,
            key,
            contentType: 'image/jpeg',
            ttlSeconds: this.documentUploadTtl,
          },
        },
      );
      const res = await fetch(ticket.url, {
        method: 'PUT',
        headers: ticket.requiredHeaders,
        body: Buffer.from(photoBase64, 'base64'),
      });
      if (!res.ok) {
        this.logger.warn(
          { driverId: driver.id, status: res.status },
          'F5: subida best-effort de la selfie del enrol FALLÓ; el alta sigue sin selfie',
        );
        return null;
      }
      return key;
    } catch (err) {
      this.logger.warn(
        { err: String(err) },
        'F5: no se pudo subir la selfie del enrol (best-effort); el alta sigue sin selfie',
      );
      return null;
    }
  }

  /** Emite el reto de liveness para iniciar turno (BR-I02) → identity-service. */
  biometricChallenge(identity: AuthenticatedUser): Promise<DriverBiometricChallenge> {
    return this.identity().post<DriverBiometricChallenge>('/drivers/shift/biometric/challenge', {
      identity,
      body: {},
    });
  }

  /** Verifica liveness+match y obtiene el sessionRef de un solo uso (BR-I02) → identity-service. */
  verifyBiometric(
    identity: AuthenticatedUser,
    dto: VerifyBiometricDto,
  ): Promise<DriverBiometricVerifyResult> {
    return this.identity().post<DriverBiometricVerifyResult>('/drivers/shift/biometric/verify', {
      identity,
      body: dto,
    });
  }

  /** Inicio de turno con gate biométrico (BR-I02). Devuelve estado + score que emite identity. */
  startShift(identity: AuthenticatedUser, dto: StartShiftDto): Promise<DriverShiftStartResult> {
    return this.identity().post<DriverShiftStartResult>('/drivers/shift/start', {
      identity,
      body: dto,
    });
  }

  endShift(identity: AuthenticatedUser): Promise<DriverShiftStatusResult> {
    return this.identity().post<DriverShiftStatusResult>('/drivers/shift/end', {
      identity,
      body: {},
    });
  }

  pauseShift(identity: AuthenticatedUser): Promise<DriverShiftStatusResult> {
    return this.identity().post<DriverShiftStatusResult>('/drivers/shift/pause', {
      identity,
      body: {},
    });
  }

  /** Estado actual del turno del conductor (currentStatus), resuelto vía identity gRPC. */
  async getShiftState(identity: AuthenticatedUser): Promise<DriverShiftStateView> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    }
    return { driverId: driver.id, status: driver.currentStatus };
  }

  /** Perfil agregado del conductor autenticado para la pantalla de cuenta/cumplimiento. */
  async getMe(identity: AuthenticatedUser): Promise<DriverProfileView> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    }

    const [user, aggregate, docs] = await Promise.all([
      this.grpc.call<UserReply>('identity', 'GetUser', { id: identity.userId }, identity),
      this.grpc.call<AggregateReply>('rating', 'GetAggregate', { subjectId: driver.id }, identity),
      this.grpc.call<DriverDocumentsReply>(
        'fleet',
        'GetDriverDocuments',
        { id: driver.id },
        identity,
      ),
    ]);

    return buildDriverProfile(driver, user, aggregate, docs);
  }

  /**
   * Documentos del conductor autenticado con su estado y vencimiento (BR-I04). Lee fleet-service
   * (gRPC GetDriverDocuments). El driverId se resuelve desde el userId; el cliente no lo provee.
   */
  async getDocuments(identity: AuthenticatedUser): Promise<DriverDocumentDetail[]> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    }
    const docs = await this.grpc.call<DriverDocumentsReply>(
      'fleet',
      'GetDriverDocuments',
      { id: driver.id },
      identity,
    );
    // Cada s3Key viene de fleet para ESTE driver (claves bajo `drivers/{driver.id}/...`, resuelto
    // server-side): firmar el read no expone docs de otro conductor. La firma es FAIL-SOFT (url null
    // por cara que falle) → la lista de docs siempre responde, el preview degrada por cara.
    return Promise.all(
      buildDriverDocuments(docs.documents ?? []).map((doc) =>
        this.attachDocumentImageUrls(identity, doc),
      ),
    );
  }

  /**
   * Cierra el paso INTERMEDIO del mapper: firma una presigned GET por cara (su key S3 interna) y proyecta
   * la vista FINAL del cliente (`DriverDocumentImageView`: side + order + url, SIN s3Key). FAIL-SOFT por
   * cara — una key inválida deja `url: null` en esa cara, no tumba el documento ni la lista.
   */
  private async attachDocumentImageUrls(
    identity: AuthenticatedUser,
    doc: DriverDocumentDetailWithKeys,
  ): Promise<DriverDocumentDetail> {
    const images = await Promise.all(
      doc.images.map(async ({ side, order, s3Key }) => ({
        side,
        order,
        url: await this.presignDocumentRead(identity, s3Key),
      })),
    );
    // Reemplaza las imágenes con-key por las firmadas; el resto del documento queda igual.
    const { images: _withKeys, ...rest } = doc;
    return { ...rest, images };
  }

  /**
   * Acuña una presigned GET URL para una imagen de documento (media-service, server-to-server). Espejo del
   * `presignDocument` del admin-bff: POST /media/internal/presign-get con ttl corto (120s). s3Key '' (sin
   * archivo) → null. FAIL-SOFT: si la firma falla devolvemos null y seguimos — no poder mostrar el preview
   * NO debe tumbar la lista de documentos (el resume del onboarding degrada esa cara, no falla).
   */
  private async presignDocumentRead(
    identity: AuthenticatedUser,
    s3Key: string,
  ): Promise<string | null> {
    if (!s3Key) return null;
    try {
      const { url } = await this.rest.client('media').post<{ url: string }>(
        '/media/internal/presign-get',
        {
          identity,
          // audience 'device': el preview lo consume la APP en el TELÉFONO → la URL debe firmarse contra el
          // host LAN (S3_PUBLIC_BASE_URL), no localhost (que en el device es el device mismo y no alcanza MinIO).
          body: {
            bucket: this.documentsBucket,
            key: s3Key,
            ttlSeconds: DOCUMENT_READ_TTL_SECONDS,
            audience: 'device',
          },
        },
      );
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Registra/actualiza un documento del conductor (BR-I04) → fleet-service por REST interno firmado.
   * Entra como PENDING_REVIEW hasta la validación manual del operador. La subida del archivo en sí
   * (S3) NO se cubre en esta ola: aquí se registra tipo/número/vencimiento (y un fileS3Key opcional
   * si la app ya subió el binario por otra vía). El driverId se resuelve desde la identidad.
   */
  async addDocument(
    identity: AuthenticatedUser,
    input: {
      type: string;
      // Opcional POR TIPO: la foto del vehículo (VEHICLE_PHOTO) no tiene número (validado aguas arriba).
      documentNumber?: string;
      issuedAt?: string;
      expiresAt?: string;
      fileS3Key?: string;
      // Sub-lote 3A: las N imágenes (caras) ya subidas vía presign. Se reenvían tal cual a fleet.
      images?: { s3Key: string; side: DocumentSide }[];
      // Onboarding sin-formularios (Lote 0): data extraída por OCR on-device + trazabilidad del motor.
      // Se reenvían tal cual a fleet, que las persiste en la misma transacción. Opcionales (backward-compat).
      extractedData?: ExtractedDocumentData;
      ocrEngine?: string;
      ocrAt?: string;
    },
  ): Promise<DriverDocumentDetail> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    }
    // Anti-IDOR de STORAGE (borde público, Ley 29733): el cliente manda las KEYS S3. El presign las
    // genera DRIVER-SCOPED server-side (`drivers/{driverId}/...`), pero el register las recibe del body.
    // Si no se acotan, un conductor podría registrar un doc apuntando a `drivers/{OTRO}/documents/...` y
    // filtrar PII ajena cuando el operador presigna el GET de esa key. Validamos TODA key entrante contra
    // el prefijo del conductor autenticado (resuelto server-side), espejando `avatar.service.assertOwnsKey`.
    this.assertDocumentKeysOwnedByDriver(driver.id, input.fileS3Key, input.images);

    // Anti-IDOR: el driverId resuelto server-side se FIRMA en la identidad propagada (igual que
    // dispatch/payments/trips), no solo en el body. fleet valida `ownerId === identity.driverId`
    // (assertDriverOwnsResource), así un conductor no puede atribuir un doc a OTRO driverId.
    const signedIdentity: AuthenticatedUser = { ...identity, driverId: driver.id };
    const created = await this.rest.client('fleet').post<FleetDocumentReply>('/documents', {
      identity: signedIdentity,
      body: {
        ownerType: 'DRIVER',
        ownerId: driver.id,
        type: input.type,
        documentNumber: input.documentNumber,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        // DEPRECADO: se mantiene por backward-compat; el camino nuevo es `images` (fleet normaliza ambos).
        fileS3Key: input.fileS3Key,
        // Sub-lote 3A: las N caras ya subidas. fleet persiste una DocumentImage por elemento (atómico).
        images: input.images,
        // Onboarding sin-formularios (Lote 0): data OCR on-device de punta a punta. fleet la persiste en
        // la MISMA transacción que el doc. Opcionales → si no vino OCR viajan undefined (backward-compat).
        extractedData: input.extractedData,
        ocrEngine: input.ocrEngine,
        ocrAt: input.ocrAt,
      },
    });
    return this.attachDocumentImageUrls(signedIdentity, buildDriverDocument(created));
  }

  /**
   * Emite un ticket de subida (presigned PUT) para el binario de un documento del conductor (Ley 29733:
   * el archivo es PII y va al storage soberano privado, no por el body de la API). Flujo:
   *   1. La app pide este ticket (type + contentType).
   *   2. Sube el binario con un PUT a `uploadUrl` reenviando `requiredHeaders` (Content-Type firmado).
   *   3. Llama POST /drivers/me/documents con el `fileS3Key` devuelto.
   *
   * Frontera de seguridad: la key es DRIVER-SCOPED (`drivers/{driverId}/documents/...`). El driverId
   * lo resuelve el servidor desde la identidad autenticada (el cliente NO lo envía), así un conductor
   * solo puede obtener una URL de escritura bajo SU propio prefijo. La extensión deriva del contentType
   * (mapa tipado), no de un nombre del cliente.
   */
  async presignDocumentUpload(
    identity: AuthenticatedUser,
    input: {
      type: FleetDocumentType;
      contentType: DocumentUploadContentType;
      // Sub-lote 3A: caras a subir (1..N). Si se omite → [SINGLE] (backward-compat, 1 imagen).
      sides?: DocumentSide[];
    },
  ): Promise<DocumentUploadTicketView> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) {
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    }

    // Backward-compat: sin `sides` → una sola cara SINGLE (el comportamiento histórico de 1 ticket).
    // DEDUP (Set): `sides` viene del cliente. Sin dedup, un `[FRONT, FRONT, …×N]` dispararía N presign-put
    // paralelos por la MISMA cara (amplificación de fan-out contra media-service). El Set colapsa duplicados
    // y acota el fan-out a la CARDINALIDAD del enum DocumentSide (SINGLE/FRONT/BACK) — sin tope numérico mágico.
    const requestedSides =
      input.sides && input.sides.length > 0 ? input.sides : [DocumentSide.SINGLE];
    const sides = [...new Set(requestedSides)];

    // Un ticket POR CARA: una key DRIVER-SCOPED distinta por cara (el uuid de buildDocumentKey las separa)
    // y un presign-put de media por key. En paralelo (cada cara es independiente). La frontera de seguridad
    // (prefijo `drivers/{driverId}/`) se preserva cara por cara: el driverId siempre se resuelve server-side.
    const tickets: DocumentUploadSideTicket[] = await Promise.all(
      sides.map(async (side) => {
        const fileS3Key = this.buildDocumentKey(driver.id, input.type, input.contentType);
        const ticket = await this.rest.client('media').post<MediaPresignPutReply>(
          '/media/internal/presign-put',
          {
            identity,
            body: {
              bucket: this.documentsBucket,
              key: fileS3Key,
              contentType: input.contentType,
              ttlSeconds: this.documentUploadTtl,
            },
          },
        );
        return {
          side,
          uploadUrl: ticket.url,
          fileS3Key,
          requiredHeaders: ticket.requiredHeaders,
        };
      }),
    );

    const expiresAt = new Date(Date.now() + this.documentUploadTtl * 1000).toISOString();

    // Observabilidad: driverId + type + cantidad de caras (metadatos), NUNCA el binario ni las URLs firmadas.
    this.logger.info(
      { driverId: driver.id, type: input.type, contentType: input.contentType, sides: sides.length },
      'tickets de subida de documento emitidos (presigned PUT, driver-scoped, 1 por cara)',
    );

    return { tickets, expiresAt };
  }

  /**
   * Anti-IDOR de STORAGE (borde público): valida que TODA clave S3 entrante (`fileS3Key` legacy + cada
   * `images[].s3Key`) viva bajo el prefijo del conductor autenticado (`drivers/{driverId}/`). Es la MISMA
   * frontera que produce `buildDocumentKey` server-side; aquí se vuelve a chequear porque el register
   * recibe la key del cliente. Fail-closed: cualquier key fuera del prefijo (cross-driver o sin prefijo) →
   * ForbiddenError (403). Espeja `media-service avatar.service.assertOwnsKey` (`avatars/${userId}/`).
   */
  private assertDocumentKeysOwnedByDriver(
    driverId: string,
    fileS3Key: string | undefined,
    images: { s3Key: string; side: DocumentSide }[] | undefined,
  ): void {
    const prefix = `drivers/${driverId}/`;
    const keys = [...(fileS3Key ? [fileS3Key] : []), ...(images ?? []).map((i) => i.s3Key)];
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        throw new ForbiddenError('La key no pertenece al conductor autenticado', {
          field: 's3Key',
          driverId,
          key,
        });
      }
    }
  }

  /**
   * Key DETERMINISTA y driver-scoped del documento: `drivers/{driverId}/documents/{type}/{uuid}.{ext}`.
   * El prefijo `drivers/{driverId}/` ES la frontera de seguridad (un conductor solo escribe bajo lo
   * suyo). El uuid evita colisiones entre reenvíos del mismo tipo; la extensión sale del contentType.
   */
  private buildDocumentKey(
    driverId: string,
    type: FleetDocumentType,
    contentType: DocumentUploadContentType,
  ): string {
    const ext = DOCUMENT_EXTENSION_BY_CONTENT_TYPE[contentType];
    return `drivers/${driverId}/documents/${type}/${uuidv7()}.${ext}`;
  }

  private identity() {
    return this.rest.client('identity');
  }
}
