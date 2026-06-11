/**
 * Sesión/onboarding del conductor.
 *  - Comandos (onboard, shift start/end/pause) → REST interno firmado a identity-service.
 *  - GET /drivers/me → agrega lecturas gRPC de identity + rating + fleet.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  DriverBiometricChallenge,
  DriverBiometricEnrollResult,
  DriverBiometricVerifyResult,
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
  buildDriverProfile,
  buildDriverVehicleFromRest,
  buildDriverVehicles,
  type FleetDriverVehicleReply,
} from './drivers.mapper';
import type {
  DriverDocumentDetail,
  DriverPersonalData,
  DriverProfileView,
  DriverVehicleView,
  EnrollFaceDto,
  OnboardDto,
  RegisterVehicleDto,
  StartShiftDto,
  UpdateDriverPersonalDto,
  VerifyBiometricDto,
} from './dto/drivers.dto';

@Injectable()
export class DriversService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  onboard(identity: AuthenticatedUser, dto: OnboardDto): Promise<unknown> {
    return this.identity().post('/drivers/onboard', { identity, body: dto });
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
  async setActiveVehicle(identity: AuthenticatedUser, vehicleId: string): Promise<DriverVehicleView> {
    const updated = await this.rest
      .client('fleet')
      .patch<FleetDriverVehicleReply>('/drivers/vehicles/active', { identity, body: { vehicleId } });
    return buildDriverVehicleFromRest(updated);
  }

  /** Enrolamiento facial de referencia (BR-I02) → identity-service. */
  enrollFace(identity: AuthenticatedUser, dto: EnrollFaceDto): Promise<DriverBiometricEnrollResult> {
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
      this.grpc.call<DriverDocumentsReply>('fleet', 'GetDriverDocuments', { id: driver.id }, identity),
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
    input: { type: string; documentNumber: string; issuedAt?: string; expiresAt?: string; fileS3Key?: string },
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

  private identity() {
    return this.rest.client('identity');
  }
}
