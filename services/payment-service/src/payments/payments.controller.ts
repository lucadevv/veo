import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Roles,
  Audiences,
  CurrentUser,
  CurrentRail,
  InternalIdentityGuard,
  AudienceGuard,
  RolesGuard,
  InternalAudience,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { assertDriverOwnsResource } from '@veo/auth';

/**
 * Rieles de los endpoints "de pasajero/operador" — los que YA existían y NO se abren a service-rail
 * (mínimo privilegio · ADR-014 §5.5): refund, retry-charge, method, settle, tip, cash, earnings. Conservan
 * EXACTAMENTE el set previo `[public, driver, admin]` (compat con los BFFs · NUNCA service-rail). Constante
 * tipada compartida — cero strings mágicos, un único punto define el set "no-servicio".
 */
const PASSENGER_RAILS = [
  InternalAudience.PUBLIC_RAIL,
  InternalAudience.DRIVER_RAIL,
  InternalAudience.ADMIN_RAIL,
] as const;
import { PaymentsService } from './payments.service';
import { ChargeMode } from './payment.policy';
import {
  AddTipDto,
  ChangeMethodDto,
  ChargeDto,
  CashConfirmDto,
  DebtQueryDto,
  EarningsQueryDto,
  RefundDto,
  SettlePenaltyDto,
} from './dto/payments.dto';
import { ForbiddenError } from '@veo/utils';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // ── CHARGE: SUMA service-rail (ADR-014 §5.5 · F3b). booking-service DISPARA el cobro del carpooling al
  // aprobar (POST /charge firmado service-rail, dedupKey = booking-charge:{bookingId}). Conserva los rieles
  // previos para los callers actuales (BFFs que cobran on-demand). Mínimo privilegio: los OTROS comandos NO
  // se abren a service-rail (ver PASSENGER_RAILS abajo). ──
  @Post('charge')
  @Audiences(
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
    InternalAudience.SERVICE_RAIL,
  )
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cobro idempotente de un viaje (BR-P01/P04). Reintento con misma dedupKey es idempotente',
  })
  charge(@Body() dto: ChargeDto, @CurrentRail() rail: InternalAudience | undefined) {
    return this.payments.charge({
      tripId: dto.tripId,
      grossCents: dto.grossCents,
      tipCents: dto.tipCents,
      method: dto.method,
      // F2.7-v2 · el MODO se determina en el PUNTO DE ENTRADA del cobro, por el RIEL (NO se enriquece el
      // contrato REST cross-service): SERVICE_RAIL = SOLO booking-service disparando el cobro del carpooling
      // (ADR-014 §5.5) → CARPOOLING (service fee SUMADO al pasajero, modelo BlaBlaCar — el conductor cobra el
      // 100%, ver payment.policy.ts). Los rieles de cliente (public/driver/admin = los BFFs que cobran
      // on-demand) → ON_DEMAND (comisión descontada al conductor). La tasa de cada modo es admin-editable.
      mode: rail === InternalAudience.SERVICE_RAIL ? ChargeMode.CARPOOLING : ChargeMode.ON_DEMAND,
      payerRef: dto.payerRef,
      driverId: dto.driverId,
      dedupKey: dto.dedupKey,
      promoCode: dto.promoCode,
      userId: dto.userId,
    });
  }

  @Get('earnings')
  @Audiences(...PASSENGER_RAILS)
  @ApiOperation({
    summary: 'Desglose real de ganancias de un conductor en una ventana [from,to) (BR-P05)',
  })
  earnings(@Query() query: EarningsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    // Anti-IDOR (defensa en profundidad): un conductor solo puede leer SUS ganancias. El driverId
    // pedido debe coincidir con el driverId firmado en la identidad interna (resuelto por el BFF).
    assertDriverOwnsResource(user, query.driverId);
    return this.payments.earningsForDriver(
      query.driverId,
      new Date(query.from),
      new Date(query.to),
    );
  }

  // ── DEBT gate (BR-P02): endpoint de DOBLE PROPÓSITO. Cómo se resuelve el passengerId depende del RIEL:
  //   · CLIENTE (public/driver/admin): SIEMPRE de la identidad firmada (CurrentUser) → ANTI-IDOR. El query
  //     `passengerId` se IGNORA: un cliente NUNCA puede espiar la deuda de otro pasajero pasándolo a mano.
  //   · SISTEMA (service-rail): ON-BEHALF-OF. booking-service deriva el gate "el pasajero con deuda no puede
  //     reservar" llamando GET /debt firmado service-rail, pero firma identidad ANÓNIMA de sistema
  //     (userId='anonymous') → el passengerId NO viaja en la identidad y DEBE venir en el query. Es seguro
  //     porque service-rail solo lo firman callers de sistema confiables (HMAC + AudienceGuard fail-closed).
  // Sin esta distinción, el riel de sistema caía a user.userId='anonymous' y el gate consultaba la deuda de
  // 'anonymous' → hasDebt:false SIEMPRE → el gate de deuda al reservar era estructuralmente NULO. Un
  // service-rail SIN passengerId es un BUG del caller (no un cliente anónimo legítimo): se RECHAZA con 403,
  // jamás se cae en silencio a 'anonymous'. Va ANTES de `@Get(':id')` para no ser capturado por la ruta
  // paramétrica. SUMA service-rail (ADR-014 §5.5 · F3a); conserva los rieles previos (public-bff debt-proxy). ──
  @Get('debt')
  @Audiences(
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
    InternalAudience.SERVICE_RAIL,
  )
  @ApiOperation({
    summary:
      'Deuda pendiente de un pasajero (cobros en DEBT). Cliente: pasajero firmado (anti-IDOR). Sistema (service-rail): on-behalf-of por query',
  })
  debt(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRail() rail: InternalAudience | undefined,
    @Query() query: DebtQueryDto,
  ) {
    return this.payments.getDebtForPassenger(this.resolveDebtPassengerId(user, rail, query));
  }

  /**
   * Resuelve QUÉ passengerId consultar en el gate de deuda según el RIEL (endpoint de doble propósito):
   *  - service-rail (on-behalf-of): el passengerId sale del QUERY (la identidad de sistema es anónima). Si
   *    falta → ForbiddenError (403): un caller de sistema SIN passengerId es un bug, NUNCA se degrada a
   *    'anonymous' (eso re-abriría el gate-NULO que esta corrección cierra).
   *  - cualquier otro riel (cliente public/driver/admin): el passengerId sale SIEMPRE de la identidad
   *    firmada (anti-IDOR). El query se IGNORA por completo — un cliente no espía deuda ajena por query.
   */
  private resolveDebtPassengerId(
    user: AuthenticatedUser,
    rail: InternalAudience | undefined,
    query: DebtQueryDto,
  ): string {
    if (rail === InternalAudience.SERVICE_RAIL) {
      if (!query.passengerId) {
        throw new ForbiddenError(
          'service-rail debe indicar passengerId (on-behalf-of); no se asume identidad anónima',
        );
      }
      return query.passengerId;
    }
    // Riel de cliente: server-truth de la identidad firmada. El query.passengerId se ignora (anti-IDOR).
    return user.userId;
  }

  @Get(':id')
  @Audiences(...PASSENGER_RAILS)
  @ApiOperation({ summary: 'Obtener un pago por id' })
  get(@Param('id') id: string) {
    return this.payments.getPayment(id);
  }

  @Post(':tripId/tip')
  @Audiences(...PASSENGER_RAILS)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Añadir propina a un viaje ya cobrado (BR-P04). Idempotente por dedupKey',
  })
  addTip(@Param('tripId') tripId: string, @Body() dto: AddTipDto) {
    return this.payments.addTip({ tripId, tipCents: dto.tipCents, dedupKey: dto.dedupKey });
  }

  @Post(':id/cash/confirm')
  @Audiences(...PASSENGER_RAILS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmación bilateral de efectivo (BR-P03), por driver o passenger' })
  confirmCash(
    @Param('id') id: string,
    @Body() dto: CashConfirmDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // El userId sale de la identidad firmada (CurrentUser), nunca del body → anti-IDOR (el dominio
    // valida que el caller sea el party del pago).
    return this.payments.confirmCash(id, user.userId, dto.party, dto.confirmed ?? true);
  }

  // ── Saldar deuda (BR-P02): re-cobra un Payment en DEBT. Idempotente (CAPTURED→no-op) y
  // concurrencia-seguro (status-guard transaccional). El BFF valida ownership ANTES (404 si ajeno). ──
  @Post(':id/retry-charge')
  @Audiences(...PASSENGER_RAILS)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Re-cobra un cobro en DEBT (saldar deuda). prontopaga→nuevo checkout; sandbox→re-cobro al riel',
  })
  retryCharge(@Param('id') id: string) {
    return this.payments.retryCharge(id);
  }

  // ── Cambiar el MÉTODO de un pago no-capturado (decisión del dueño): el usuario que no pudo pagar el
  // Yape elige otro DIGITAL. Solo PENDING/DEBT (409 si CAPTURED/REFUNDED); CASH→422. Re-corre el cobro
  // con el método nuevo (nuevo checkout). NO toca Trip.paymentMethod (histórico). El BFF valida ownership. ──
  @Post(':id/method')
  @Audiences(...PASSENGER_RAILS)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cambia el método de un pago no-capturado (PENDING/DEBT) entre métodos digitales y re-cobra. CASH→422; CAPTURED→409',
  })
  changeMethod(@Param('id') id: string, @Body() dto: ChangeMethodDto) {
    return this.payments.changeMethod(id, dto.method);
  }

  // ── Saldar una penalidad de cancelación (F2.3): el pasajero la paga por el rail, "como un DEBT". El
  // passengerId sale SIEMPRE de la identidad firmada (CurrentUser) → anti-IDOR (la penalidad ajena → 404).
  // Idempotente por la dedupKey del Payment de liquidación. Al capturarse, la penalidad pasa a COLLECTED. ──
  @Post('penalties/:id/settle')
  @Audiences(...PASSENGER_RAILS)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Saldar una penalidad de cancelación PENDING por el rail (método digital). CASH→422; WAIVED→409',
  })
  settlePenalty(
    @Param('id') id: string,
    @Body() dto: SettlePenaltyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.settleCancellationPenalty({
      penaltyId: id,
      passengerId: user.userId,
      method: dto.method,
      payerRef: dto.payerRef,
    });
  }

  // ── Reembolso (BR-P06): operadores de soporte. >S/30 requiere L2 (validado en el servicio). NO se abre a
  // service-rail (mínimo privilegio · ADR-014 §5.5): el riel admin + el RBAC de operador lo gatean. ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPPORT_L1, AdminRole.SUPPORT_L2, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Audiences(...PASSENGER_RAILS)
  @Post(':tripId/refund')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reembolso de un viaje (BR-P06). Ventana 7 días; >S/30 requiere L2' })
  refund(
    @Param('tripId') tripId: string,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthenticatedUser,
    // Idempotency-Key del operador (panel admin) → barrera dura contra el doble-reembolso parcial.
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ) {
    return this.payments.refund(tripId, dto.amountCents, dto.reason, user, idempotencyKey);
  }
}
