import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBase64,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  Roles,
  CurrentUser,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DriversService, type DriverPurgeResult } from './drivers.service';
import { DriverStatus } from '../generated/prisma';
import { IsPlausibleBirthDate } from '../common/is-plausible-birth-date';

class OnboardDto {
  @IsString()
  licenseNumber!: string;

  @IsISO8601()
  licenseExpiresAt!: string;
}

class StartShiftDto {
  @IsString()
  sessionRef!: string;

  @IsOptional()
  @IsNumber()
  geoLat?: number;

  @IsOptional()
  @IsNumber()
  geoLon?: number;
}

/**
 * Tope de longitud del base64 POR FRAME (chars). El liveness manda varios frames en un solo body (límite
 * del parser 'json' 5mb ≈ 6.99M chars base64 TOTAL). Con hasta `ENROLL_FRAMES_MAX` frames, cada uno se
 * acota para que la suma no reviente el body parser y un frame suelto no sea desproporcionado.
 */
const FRAME_BASE64_MAX = 1_500_000;
/**
 * Piso de longitud del base64 POR FRAME: un frame JPEG real son decenas de KB → decenas de miles de chars
 * base64. 2000 descarta trivialidades (`"x"`, `"AAAA"`) sin rozar el happy path de un frame real.
 */
const FRAME_BASE64_MIN = 2_000;
/** Tope de frames del reto de liveness: 30 (una secuencia corta, no un video largo). El piso (≥1) lo da @ArrayNotEmpty. */
const ENROLL_FRAMES_MAX = 30;

/**
 * POST /drivers/biometric/enroll → body. Enrolamiento CON LIVENESS (BR-I02): el conductor manda el
 * `challengeId` del reto + los `frames` capturados mientras ejecutaba la acción. ENDURECIMIENTO del payload
 * (gate biométrico server-side): challengeId no vacío y cada frame base64 VÁLIDO y NO trivial (mín/máx por
 * frame), con un tope de cantidad de frames. Errores tipados (400) en el borde; el liveness real lo resuelve
 * el biometric-service. Reemplaza el viejo `{ photo }` (una foto suelta era spoofeable con una imagen).
 */
export class EnrollFaceDto {
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ENROLL_FRAMES_MAX)
  @IsString({ each: true })
  @IsBase64({}, { each: true })
  @MinLength(FRAME_BASE64_MIN, { each: true })
  @MaxLength(FRAME_BASE64_MAX, { each: true })
  frames!: string[];
}

class VerifyBiometricDto {
  @IsString()
  challengeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  frames!: string[];
}

/**
 * POST /drivers/:id/dni-face-match → body (sub-lote 3C · BINDING). El admin-bff baja la foto FRONT del DNI
 * de S3 y la pasa como base64 (`image`). El embedding de referencia NO viaja en el body: lo lee el servicio
 * de la fila GUARDADA del conductor (server-truth · garantía de seguridad). Endurecimiento del payload:
 * base64 válido y no trivial, con tope alineado al de los frames de enroll (mismo orden de magnitud).
 */
class DniFaceMatchDto {
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  @MinLength(FRAME_BASE64_MIN)
  @MaxLength(FRAME_BASE64_MAX)
  image!: string;
}

class RejectDriverDto {
  // Motivo del rechazo (opcional). Texto del operador que el conductor verá en la app. Sin motivo → "".
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class SuspendDriverDto {
  // Motivo de la suspensión manual (OBLIGATORIO): queda en la traza de auditoría y en el evento
  // driver.suspended. A diferencia del rechazo, suspender es una acción de SAFETY deliberada: exigimos
  // un motivo no vacío (el operador debe justificar por qué saca al conductor de circulación).
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

class UpdatePersonalInfoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  legalName!: string;

  // DNI peruano: exactamente 8 dígitos.
  @IsString()
  @Matches(/^\d{8}$/, { message: 'El DNI debe tener exactamente 8 dígitos' })
  dni!: string;

  // Fecha de nacimiento en formato ISO yyyy-mm-dd (sin hora). Además de formato y fecha válida, se
  // exige que NO sea futura y que dé una edad plausible (18–100 años) — BR-I04.
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthDate debe tener formato yyyy-mm-dd' })
  @IsPlausibleBirthDate()
  birthDate!: string;
}

@ApiTags('drivers')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Post('onboard')
  @ApiOperation({ summary: 'Onboarding del conductor (licencia) → PENDING de aprobación' })
  onboard(@CurrentUser() user: AuthenticatedUser, @Body() dto: OnboardDto) {
    return this.drivers.onboard(user.userId, dto);
  }

  @Get('me/biometric/liveness/challenge')
  @ApiOperation({ summary: 'Emitir reto de liveness para enrolar el rostro (BR-I02)' })
  enrollChallenge(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.createEnrollChallenge(user.userId);
  }

  @Post('biometric/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enrolar el rostro de referencia del conductor con liveness (BR-I02)' })
  enrollFace(@CurrentUser() user: AuthenticatedUser, @Body() dto: EnrollFaceDto) {
    return this.drivers.enrollFace(user.userId, dto);
  }

  @Post('shift/biometric/challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir reto de liveness para iniciar turno (BR-I02)' })
  biometricChallenge(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.createBiometricChallenge(user.userId);
  }

  @Post('shift/biometric/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar liveness+match y mintear sessionRef de turno (BR-I02)' })
  verifyBiometric(@CurrentUser() user: AuthenticatedUser, @Body() dto: VerifyBiometricDto) {
    return this.drivers.verifyBiometric(user.userId, dto);
  }

  @Post('shift/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Iniciar turno con verificación biométrica (BR-I02)' })
  startShift(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartShiftDto) {
    return this.drivers.startShift(user.userId, dto);
  }

  @Post('shift/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finalizar turno (OFFLINE)' })
  endShift(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.setStatus(user.userId, DriverStatus.OFFLINE);
  }

  @Post('shift/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pausar turno (ON_BREAK)' })
  pauseShift(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.setStatus(user.userId, DriverStatus.ON_BREAK);
  }

  @Patch('me/personal')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registrar/actualizar datos personales del conductor (BR-I04)' })
  updatePersonalInfo(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePersonalInfoDto) {
    return this.drivers.updatePersonalInfo(user.userId, dto);
  }

  // ── Operador (RBAC) ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('pending-approval')
  @ApiOperation({ summary: 'Listar conductores pendientes de aprobación' })
  listPending() {
    return this.drivers.listPendingApproval();
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprobar antecedentes del conductor (KYC VERIFIED)' })
  approve(@Param('id') id: string) {
    return this.drivers.approve(id);
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/dni-face-match')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Face-match DNI↔selfie: cotejar la foto FRONT del DNI vs la biometría enrolada del conductor (BINDING · 3C)',
  })
  dniFaceMatch(@Param('id') id: string, @Body() dto: DniFaceMatchDto) {
    return this.drivers.matchDniFace(id, { image: dto.image });
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Rechazar conductor (con motivo opcional)' })
  async reject(@Param('id') id: string, @Body() dto: RejectDriverDto): Promise<void> {
    await this.drivers.reject(id, dto.reason ?? '');
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/suspend')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Suspender manualmente a un conductor (SAFETY · con motivo obligatorio)',
  })
  async suspend(@Param('id') id: string, @Body() dto: SuspendDriverDto): Promise<void> {
    await this.drivers.suspend(id, dto.reason);
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/reactivate')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Reactivar a un conductor suspendido (solo suspensiones disciplinarias)',
  })
  async reactivate(@Param('id') id: string): Promise<void> {
    await this.drivers.reactivate(id);
  }

  // ── HARD purge (SUPERADMIN) ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'HARD purge del conductor (re-registro): borra Driver + User + auth/biometría/consents. SUPERADMIN.',
  })
  purge(@Param('id') id: string): Promise<DriverPurgeResult> {
    return this.drivers.purge(id);
  }

  // ── Self-service: reenvío a revisión tras corregir (resubmit) ──
  @Post('me/resubmit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenviar a revisión tras un rechazo (REJECTED → PENDING)' })
  resubmit(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.resubmit(user.userId);
  }
}
