import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { PaymentsService } from './payments.service';
import { CashConfirmDto, ChangeMethodDto, ChargeDto, SettlePenaltyDto, type DebtView, type PaymentView } from './dto/payments.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('charge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cobro idempotente de un viaje (BR-P01/P04)' })
  charge(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChargeDto): Promise<PaymentView> {
    return this.payments.charge(user, dto);
  }

  @Get('by-trip/:tripId')
  @ApiOperation({
    summary:
      'Cobro de un viaje por tripId (re-entrada del recibo). Anti-IDOR: solo si el viaje es del ' +
      'pasajero autenticado (404 si ajeno/inexistente; 404 si el viaje aún no tiene cobro).',
  })
  getByTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') tripId: string,
  ): Promise<PaymentView> {
    return this.payments.getPaymentByTrip(user, tripId);
  }

  // ── Deudas del pasajero (banner de la app): cobros en DEBT. Va ANTES de `@Get(':id')`. ──
  @Get('debts')
  @ApiOperation({ summary: 'Deudas pendientes del pasajero autenticado (cobros en DEBT) para el banner de la app' })
  debts(@CurrentUser() user: AuthenticatedUser): Promise<DebtView> {
    return this.payments.getMyDebts(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un pago por id' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PaymentView> {
    return this.payments.getPayment(user, id);
  }

  @Post(':id/cash/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmación de efectivo por el pasajero (BR-P03)' })
  confirmCash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CashConfirmDto,
  ): Promise<PaymentView> {
    return this.payments.confirmCash(user, id, dto);
  }

  // ── Saldar deuda (BR-P02): re-cobra un cobro en DEBT del pasajero. Ownership 404 anti-enumeración. ──
  @Post(':id/retry-charge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-cobra un cobro en DEBT del pasajero (saldar deuda). 404 si el cobro no es suyo' })
  retryCharge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PaymentView> {
    return this.payments.retryCharge(user, id);
  }

  // ── Pagar una penalidad de cancelación (F2.3): la salda por el rail "como un DEBT". El passengerId
  // sale de la identidad firmada → payment-service hace el anti-IDOR (404 si la penalidad es ajena).
  // CASH→400 (DTO). Tras saldar, invalida el cache "sin deuda" del gate. ──
  @Post('penalties/:id/settle')
  @HttpCode(200)
  @ApiOperation({ summary: 'Paga una penalidad de cancelación PENDING del pasajero por un método digital. 404 si no es suya; 409 si fue perdonada' })
  settlePenalty(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SettlePenaltyDto,
  ): Promise<PaymentView> {
    return this.payments.settlePenalty(user, id, dto.method, dto.payerRef);
  }

  // ── Cambiar el método de un pago pendiente del pasajero (no pudo pagar el Yape → elige otro DIGITAL).
  // Ownership 404 anti-enumeración + validación IsIn digitales. CASH→400 (DTO). CAPTURED→409; CASH al
  // servicio→422. El método es del Payment (cómo se liquida AHORA), no del Trip (histórico). ──
  @Post(':id/method')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cambia el método de un pago pendiente del pasajero entre métodos digitales y re-cobra. 404 si no es suyo; 409 si ya capturado' })
  changeMethod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeMethodDto,
  ): Promise<PaymentView> {
    return this.payments.changeMethod(user, id, dto.method);
  }
}
