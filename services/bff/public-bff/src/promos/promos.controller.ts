import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { PromosService } from './promos.service';
import { ValidatePromoDto, type PromoValidationView } from './dto/promo.dto';

@ApiTags('promos')
@ApiBearerAuth()
@Controller('promos')
export class PromosController {
  constructor(private readonly promos: PromosService) {}

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Previsualiza el descuento de un cupón sobre una cotización (BR Ola 2A)',
  })
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidatePromoDto,
  ): Promise<PromoValidationView> {
    return this.promos.validate(user, dto.code, dto.fareCents);
  }
}
