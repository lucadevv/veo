/**
 * Sesión/onboarding del conductor. Todos los endpoints exigen JWT de tipo 'driver'.
 */
import { Body, Controller, Get, HttpCode, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type {
  DriverBiometricChallenge,
  DriverBiometricEnrollResult,
  DriverBiometricVerifyResult,
  DriverDocument,
  DriverResubmitResult,
  DriverShiftStartResult,
  DriverShiftStateView,
  DriverShiftStatusResult,
} from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { DriversService } from './drivers.service';
import {
  AddDocumentDto,
  EnrollFaceDto,
  ListVehicleModelsQuery,
  OnboardDto,
  RegisterVehicleDto,
  RequestVehicleModelDto,
  SelectActiveVehicleDto,
  StartShiftDto,
  UpdateDriverPersonalDto,
  VerifyBiometricDto,
  type DriverModelRequestView,
  type DriverPersonalData,
  type DriverProfileView,
  type DriverVehicleModelView,
  type DriverVehicleView,
} from './dto/drivers.dto';

/** Mínimo del response para fijar el status (204) sin acoplar a express/fastify. */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('drivers')
@DriverApi()
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil del conductor + rating + estado de cumplimiento de documentos' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<DriverProfileView> {
    return this.drivers.getMe(user);
  }

  @Get('me/documents')
  @ApiOperation({ summary: 'Documentos del conductor con estado y vencimiento (BR-I04)' })
  documents(@CurrentUser() user: AuthenticatedUser): Promise<DriverDocument[]> {
    return this.drivers.getDocuments(user);
  }

  @Post('me/documents')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Registrar/actualizar un documento del conductor (queda PENDING_REVIEW). BR-I04',
  })
  addDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddDocumentDto,
  ): Promise<DriverDocument> {
    return this.drivers.addDocument(user, dto);
  }

  @Post('onboard')
  @ApiOperation({ summary: 'Onboarding del conductor (licencia) → PENDING de aprobación' })
  onboard(@CurrentUser() user: AuthenticatedUser, @Body() dto: OnboardDto): Promise<unknown> {
    return this.drivers.onboard(user, dto);
  }

  @Post('me/resubmit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenviar a revisión tras un rechazo (REJECTED → PENDING)' })
  resubmit(@CurrentUser() user: AuthenticatedUser): Promise<DriverResubmitResult> {
    return this.drivers.resubmit(user);
  }

  @Patch('me/personal')
  @ApiOperation({ summary: 'Actualizar datos personales del conductor (nombre legal, DNI, nacimiento)' })
  updatePersonal(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDriverPersonalDto,
  ): Promise<DriverPersonalData> {
    return this.drivers.updatePersonal(user, dto);
  }

  @Post('vehicles')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar el vehículo del conductor (queda pendiente de verificación)' })
  registerVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterVehicleDto,
  ): Promise<DriverVehicleView> {
    return this.drivers.registerVehicle(user, dto);
  }

  @Get('vehicle-models')
  @ApiOperation({ summary: 'Catálogo APROBADO de modelos para el selector del onboarding. Filtros: vehicleType, q' })
  vehicleModels(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVehicleModelsQuery,
  ): Promise<DriverVehicleModelView[]> {
    return this.drivers.listVehicleModels(user, query);
  }

  @Post('vehicle-models')
  @HttpCode(201)
  @ApiOperation({ summary: 'El conductor solicita un modelo nuevo que no está en el catálogo (queda en revisión)' })
  requestVehicleModel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestVehicleModelDto,
  ): Promise<DriverModelRequestView> {
    return this.drivers.requestVehicleModel(user, dto);
  }

  @Get('vehicles')
  @ApiOperation({ summary: 'Listar los vehículos del conductor autenticado (rehidratación)' })
  vehicles(@CurrentUser() user: AuthenticatedUser): Promise<DriverVehicleView[]> {
    return this.drivers.getVehicles(user);
  }

  @Get('active-vehicle')
  @ApiOperation({ summary: 'Vehículo ACTIVO (operado) del conductor; 200 + vehículo o 204 si ninguno' })
  async activeVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<DriverVehicleView | undefined> {
    const vehicle = await this.drivers.getActiveVehicle(user);
    if (!vehicle) {
      res.status(204);
      return undefined;
    }
    return vehicle;
  }

  @Patch('active-vehicle')
  @ApiOperation({ summary: 'Seleccionar el vehículo ACTIVO del conductor (server-authoritative)' })
  selectActiveVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectActiveVehicleDto,
  ): Promise<DriverVehicleView> {
    return this.drivers.setActiveVehicle(user, dto.vehicleId);
  }

  @Get('shift/state')
  @ApiOperation({ summary: 'Estado actual del turno del conductor (currentStatus)' })
  shiftState(@CurrentUser() user: AuthenticatedUser): Promise<DriverShiftStateView> {
    return this.drivers.getShiftState(user);
  }

  @Post('biometric/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enrolar el rostro de referencia del conductor (BR-I02)' })
  enrollFace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EnrollFaceDto,
  ): Promise<DriverBiometricEnrollResult> {
    return this.drivers.enrollFace(user, dto);
  }

  @Post('shift/biometric/challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir reto de liveness para iniciar turno (BR-I02)' })
  biometricChallenge(@CurrentUser() user: AuthenticatedUser): Promise<DriverBiometricChallenge> {
    return this.drivers.biometricChallenge(user);
  }

  @Post('shift/biometric/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar liveness+match y obtener sessionRef de turno (BR-I02)' })
  verifyBiometric(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyBiometricDto,
  ): Promise<DriverBiometricVerifyResult> {
    return this.drivers.verifyBiometric(user, dto);
  }

  @Post('shift/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Iniciar turno con verificación biométrica (BR-I02)' })
  startShift(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartShiftDto,
  ): Promise<DriverShiftStartResult> {
    return this.drivers.startShift(user, dto);
  }

  @Post('shift/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finalizar turno (OFFLINE)' })
  endShift(@CurrentUser() user: AuthenticatedUser): Promise<DriverShiftStatusResult> {
    return this.drivers.endShift(user);
  }

  @Post('shift/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pausar turno (ON_BREAK)' })
  pauseShift(@CurrentUser() user: AuthenticatedUser): Promise<DriverShiftStatusResult> {
    return this.drivers.pauseShift(user);
  }
}
