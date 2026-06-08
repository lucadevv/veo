/**
 * Pagos y payouts del conductor. JWT de tipo 'driver'.
 * Nota: el disparo de la liquidación (/payouts/run) es exclusivo de admin y NO se expone aquí.
 */
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { PaymentsService } from './payments.service';
import type { PaymentView } from './dto/payments.dto';

@ApiTags('payments')
@DriverApi()
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payouts')
  @ApiOperation({ summary: 'Listar payouts del conductor autenticado' })
  payouts(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.payments.listMyPayouts(user);
  }

  @Get('payments/:id')
  @ApiOperation({ summary: 'Obtener un pago por id (gRPC)' })
  getPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentView> {
    return this.payments.getPayment(id, user);
  }
}
