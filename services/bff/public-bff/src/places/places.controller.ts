import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard, type AuthenticatedUser } from '@veo/auth';
import { PlacesService } from './places.service';
import { SavePlaceDto, UpdatePlaceDto, type PlaceView } from './dto/places.dto';

/**
 * Lugares guardados del pasajero (Casa/Trabajo/favoritos) bajo /api/v1/places.
 * El gate es el JWT (`JwtAuthGuard`) + el scoping server-side por userId: el `@CurrentUser()` viene
 * del token autenticado y se firma en la identidad interna; el cuerpo NUNCA lleva userId (anti-IDOR).
 */
@ApiTags('places')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar los lugares guardados del usuario' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<PlaceView[]> {
    return this.places.list(user);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Guardar un lugar (HOME/WORK hacen upsert; FAVORITE admite varios)' })
  save(@CurrentUser() user: AuthenticatedUser, @Body() dto: SavePlaceDto): Promise<PlaceView> {
    return this.places.save(user, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar un lugar guardado del usuario' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePlaceDto,
  ): Promise<PlaceView> {
    return this.places.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar un lugar guardado del usuario' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.places.remove(user, id);
  }
}
