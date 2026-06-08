import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto, NotificationView } from './dto/notification.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Encolar una notificación (motor propio: dedup + retry + routing)' })
  enqueue(@Body() dto: CreateNotificationDto): Promise<NotificationView> {
    return this.notifications.enqueue(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una notificación por id' })
  getById(@Param('id') id: string): Promise<NotificationView> {
    return this.notifications.getById(id);
  }

  @Get()
  @ApiOperation({ summary: 'Listar notificaciones por destinatario' })
  @ApiQuery({ name: 'recipientId', required: true })
  @ApiQuery({ name: 'limit', required: false })
  list(
    @Query('recipientId') recipientId: string,
    @Query('limit') limit?: string,
  ): Promise<NotificationView[]> {
    return this.notifications.listByRecipient(recipientId, limit ? Number(limit) : undefined);
  }
}
