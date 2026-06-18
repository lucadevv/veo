/**
 * Sesión/onboarding del conductor.
 *  - Comandos (onboard, shift start/end/pause) → REST interno firmado a identity-service.
 *  - GET /drivers/me → agrega lecturas gRPC de identity + rating + fleet.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError, uuidv7 } from '@veo/utils';
import { createLogger, type Logger } from '@veo/observability';
import type { FleetDocumentType } from '@veo/shared-types';
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
  type FleetDriverVehicleReply,
  type FleetVehicleModelPageReply,
  type FleetVehicleModelRequestReply,
} from './drivers.mapper';
import {
  DOCUMENT_EXTENSION_BY_CONTENT_TYPE,
  type DocumentUploadContentType,
  type DocumentUploadTicketView,
} from './dto/drivers.dto';
import type {
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
    return buildDriverVehicleFromRest(updated);
  }

  /** Enrolamiento facial de referencia (BR-I02) → identity-service. */
  enrollFace(
    identity: AuthenticatedUser,
    dto: EnrollFaceDto,
  ): Promise<DriverBiometricEnrollResult> {
    return this.identity().post<DriverBiometricEnrollResult>('/drivers/biometric/enroll', {
      identity,
      body: dto,
    });
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
    return buildDriverDocuments(docs.documents ?? []);
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
      documentNumber: string;
      issuedAt?: string;
      expiresAt?: string;
      fileS3Key?: string;
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
    const created = await this.rest.client('fleet').post<FleetDocumentReply>('/documents', {
      identity,
      body: {
        ownerType: 'DRIVER',
        ownerId: driver.id,
        type: input.type,
        documentNumber: input.documentNumber,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        fileS3Key: input.fileS3Key,
      },
    });
    return buildDriverDocument(created);
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
    input: { type: FleetDocumentType; contentType: DocumentUploadContentType },
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

    const expiresAt = new Date(Date.now() + this.documentUploadTtl * 1000).toISOString();

    // Observabilidad: se loguea driverId + type (metadatos), NUNCA el binario ni la URL firmada.
    this.logger.info(
      { driverId: driver.id, type: input.type, contentType: input.contentType },
      'ticket de subida de documento emitido (presigned PUT, driver-scoped)',
    );

    return {
      uploadUrl: ticket.url,
      fileS3Key,
      requiredHeaders: ticket.requiredHeaders,
      expiresAt,
    };
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
