import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Roles,
  CurrentUser,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { assertDriverOwnsResource } from '@veo/auth';
import { PaymentsService } from './payments.service';
import {
  AddTipDto,
  ChangeMethodDto,
  ChargeDto,
  CashConfirmDto,
  EarningsQueryDto,
  RefundDto,
  SettlePenaltyDto,
} from './dto/payments.dto';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('charge')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cobro idempotente de un viaje (BR-P01/P04). Reintento con misma dedupKey es idempotente',
  })
  charge(@Body() dto: ChargeDto) {
    return this.payments.charge({
      tripId: dto.tripId,
      grossCents: dto.grossCents,
      tipCents: dto.tipCents,
      method: dto.method,
      payerRef: dto.payerRef,
      driverId: dto.driverId,
      dedupKey: dto.dedupKey,
      promoCode: dto.promoCode,
      userId: dto.userId,
    });
  }

  @Get('earnings')
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

  // ── DEBT gate (BR-P02): deuda pendiente del PASAJERO autenticado. El passengerId sale SIEMPRE de la
  // identidad firmada (CurrentUser), nunca de un parámetro → anti-IDOR. Va ANTES de `@Get(':id')` para
  // no ser capturado por la ruta paramétrica. ──
  @Get('debt')
  @ApiOperation({
    summary:
      'Deuda pendiente del pasajero autenticado (cobros en DEBT). Alimenta el gate de nuevos viajes',
  })
  debt(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.getDebtForPassenger(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un pago por id' })
  get(@Param('id') id: string) {
    return this.payments.getPayment(id);
  }

  @Post(':tripId/tip')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Añadir propina a un viaje ya cobrado (BR-P04). Idempotente por dedupKey',
  })
  addTip(@Param('tripId') tripId: string, @Body() dto: AddTipDto) {
    return this.payments.addTip({ tripId, tipCents: dto.tipCents, dedupKey: dto.dedupKey });
  }

  @Post(':id/cash/confirm')
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

  // ── Reembolso (BR-P06): operadores de soporte. >S/30 requiere L2 (validado en el servicio). ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPPORT_L1, AdminRole.SUPPORT_L2, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':tripId/refund')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reembolso de un viaje (BR-P06). Ventana 7 días; >S/30 requiere L2' })
  refund(
    @Param('tripId') tripId: string,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.refund(tripId, dto.amountCents, dto.reason, user);
  }
}
